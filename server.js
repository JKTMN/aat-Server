/**
 * Heroku-ready server configuration with accessibility audit and image captioning endpoints
 * @see https://devcenter.heroku.com/articles/nodejs-support
 */
const express = require('express');
const puppeteer = require('puppeteer');
const { AxePuppeteer } = require('axe-puppeteer');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const { isURL } = require('validator');
const fileUpload = require('express-fileupload');
const path = require('path');
const fetch = require('node-fetch');

if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(fileUpload());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : '*'
}));

process.on('exit', () => {
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

const validMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', environment: process.env.NODE_ENV || 'development' });
});

const runAccessibilityAudit = async (url) => {
    const browser = await puppeteer.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
      });

    const page = await browser.newPage();
    await page.goto(url);

    const results = await new AxePuppeteer(page).analyze();

    await browser.close();

    return {
        url,
        passes: await formatResults(results.passes || [], false,  url),
        violations: await formatResults(results.violations || [], true, url),
        incomplete: await formatResults(results.incomplete || [], false,  url),
        inapplicable: await formatResults(results.inapplicable || [], false, url),
        testsRun: [...results.passes, ...results.violations, ...results.inapplicable, ...results.incomplete].map(test => ({
            id: test.id,
            title: test.help,
            description: test.description || 'No description available',
            tags: test.tags || []
        }))
    };
};

app.post('/api/audit', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const auditResults = await runAccessibilityAudit(url);
        res.json(auditResults);
    } catch (error) {
        console.error('Error running accessibility audit:', error);
        res.status(500).json({ error: 'Failed to run accessibility audit' });
    }
});




app.post('/api/caption/file', async (req, res) => {
    const start = Date.now();
    try {
      if (!req.files?.image) return res.status(400).send('No image uploaded');
  
      const image = req.files.image;
  
      if (!validMimeTypes.has(image.mimetype)) {
        return res.status(415).json({ error: 'Unsupported file type' });
      }
  
      const imagePath = `./uploads/${Date.now()}_${image.name}`;
      await image.mv(imagePath);
  
      const pythonProcess = spawn('python3', ['caption_generator.py', imagePath]);
      let caption = '';
  
      pythonProcess.stdout.on('data', (data) => {
        caption += data.toString();
      });
  
      pythonProcess.on('close', (code) => {
        fs.unlink(imagePath, (err) => {
          if (err) console.error("Failed to delete uploaded file:", err);
        });
  
        if (code !== 0) return res.status(500).send('Caption generation failed');
        res.json({ caption: caption.trim() });
        const end = Date.now();
        console.log(`Image processed in ${end - start} ms`);
      });
    } catch (err) {
      res.status(500).send('Server error');
    }
  });




app.post('/api/caption/source', async (req, res) => {
    const start = Date.now();
    try {
      const { url } = req.body;
      if (!url || !isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
        return res.status(400).json({ error: 'Invalid URL' });
      }

      if (!url.match(/\.(jpe?g|png|webp)$/i)) {
        return res.status(400).json({ error: 'URL must point to an image file' });
      }
  
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch image');
      
      const imagePath = `./uploads/${Date.now()}_url_image.jpg`;
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fs.promises.writeFile(imagePath, buffer);
  
      const pythonProcess = spawn('python3', ['caption_generator.py', imagePath]);
      let caption = '';
  
      pythonProcess.stdout.on('data', (data) => {
        caption += data.toString();
      });
  
      pythonProcess.on('close', (code) => {
        fs.unlink(imagePath, (err) => {
          if (err) console.error("Failed to delete temp file:", err);
        });
  
        if (code !== 0) return res.status(500).send('Caption generation failed');
        res.json({ caption: caption.trim() });
        const end = Date.now();
        console.log(`Image processed in ${end - start} ms`);
      });
  
    } catch (err) {
      res.status(500).send(`URL processing failed: ${err.message}`);
    }
  });




app.post('/api/captions/website', async (req, res) => {
    const start = Date.now();
    const tempFiles = [];
    const urlMap = new Map();

    try {
        const { url } = req.body;
        if (!url || !isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        const images = await scrapeImageSources(url);
        const downloadPromises = images.map(async (img, index) => {
            try {
                const response = await fetch(img.src);
                if (!response.ok) throw new Error('Failed to fetch image');
                
                const contentType = response.headers.get('content-type');
                if (!validMimeTypes.has(contentType)) {
                    throw new Error('Unsupported MIME type');
                }

                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const imagePath = `./uploads/website_image_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}.jpg`;
                
                await fs.promises.writeFile(imagePath, buffer);
                tempFiles.push(imagePath);
                urlMap.set(imagePath, img.src);
                
                return imagePath;
            } catch (err) {
                console.error(`Skipping image ${img.src}:`, err.message);
                return null;
            }
        });

        const tempPaths = (await Promise.all(downloadPromises)).filter(Boolean);
        if (tempPaths.length === 0) {
            return res.status(400).json({ error: 'No processable images found' });
        }

        const pythonProcess = spawn('python3', ['caption_generator.py', ...tempPaths]);
        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => output += data.toString());
        pythonProcess.stderr.on('data', (data) => errorOutput += data.toString());

        const results = await new Promise((resolve, reject) => {
            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Python process failed: ${errorOutput}`));
                }
                
                try {
                    const parsed = JSON.parse(output);
                    resolve(parsed.map(item => ({
                        src: urlMap.get(item.path),
                        caption: item.caption
                    })));
                } catch (e) {
                    reject(new Error('Failed to parse Python output'));
                }
            });
        });

        const finalResults = results.filter(item => 
            item.src && item.caption && !item.caption.includes('Error')
        );

        res.json(finalResults);
        console.log(`Processed ${finalResults.length}/${tempPaths.length} images in ${Date.now() - start}ms`);

    } catch (err) {
        console.error('Website caption error:', err);
        res.status(500).json({ error: err.message || 'Failed to process website images' });
    } finally {
        await Promise.allSettled(tempFiles.map(file => 
            fs.promises.unlink(file).catch(() => {})
        ));
    }
});




const formatResults = async (items, pageUrl = '') => {
    const results = await Promise.all(items.map(async item => {
    const formattedItem = {
        id: item.id,
        impact: item.impact || 'N/A',
        description: item.description || 'No description available',
        help: item.help,
        helpUrl: item.helpUrl,
        tags: item.tags || [],
        pageUrl: pageUrl || '',
        nodes: item?.nodes.map(node => ({
        html: node?.html || "No HTML available",
        message: Array.isArray(node?.any) && node.any.length > 0
            ? node.any.map(error => error.message).join(', ')
            : "Error message not available",
        target: node?.target || "No target available"
        })) || [],
    };

    return formattedItem;
    }));

    return results;
};


const scrapeImageSources = async (url) => {
    const browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    const page = await browser.newPage();
    
    try {
        await page.goto(url);
        const images = await page.$$eval('img', (imgs, pageUrl) => {
            return imgs.map(img => {
                try {
                    const resolvedUrl = new URL(img.src, pageUrl).href;
                    return { src: resolvedUrl, valid: true };
                } catch (e) {
                    return { src: img.src, valid: false, error: e.message };
                }
            });
        }, url);
        
        return images.filter(img => img.valid);
    } finally {
        await browser.close();
    }
};

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
});