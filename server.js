const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(__dirname, 'assets', 'audio');
const IMAGES_DIR = path.join(__dirname, 'assets', 'images');
const SKIN_IMAGES_DIR = path.join(__dirname, 'assets', 'skin-images');

[DATA_DIR, AUDIO_DIR, IMAGES_DIR, SKIN_IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use('/assets/audio', express.static(AUDIO_DIR));
app.use('/assets/images', express.static(IMAGES_DIR));
app.use('/assets/skins', express.static(path.join(__dirname, 'assets', 'skins')));
app.use('/assets/skin-images', express.static(SKIN_IMAGES_DIR));
app.use(express.static(__dirname));

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('加载配置失败:', e);
  }
  return {
    schedules: [],
    programs: [],
    liveNews: [],
    images: [],
    workflows: [],
    workflowRuns: [],
    ttsWorkflows: [],
    ttsAudios: [],
    broadcasts: [],
    currentSkin: 'cyberpunk',
    skins: {}
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('保存配置失败:', e);
    return false;
  }
}

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const success = saveConfig(req.body);
  if (success) {
    res.json({ success: true, message: '配置已保存' });
  } else {
    res.status(500).json({ success: false, message: '保存失败' });
  }
});

// 背景图库API
const SKINS_DIR = path.join(__dirname, 'assets', 'skins');
if (!fs.existsSync(SKINS_DIR)) {
  fs.mkdirSync(SKINS_DIR, { recursive: true });
}

app.get('/api/skins/backgrounds', (req, res) => {
  try {
    const files = fs.readdirSync(SKINS_DIR);
    const imageFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    
    const backgrounds = imageFiles.map(filename => ({
      filename,
      name: filename.replace(/\.[^.]+$/, ''),
      url: `http://localhost:${PORT}/assets/skins/${filename}`
    }));
    
    res.json(backgrounds);
  } catch (e) {
    console.error('扫描背景图失败:', e);
    res.json([]);
  }
});

const multer = require('multer');
const upload = multer({ dest: require('os').tmpdir() });

app.post('/api/skins/backgrounds/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '没有上传文件' });
    }
    
    const name = req.body.name || 'background';
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `${name}-${Date.now()}${ext}`;
    const destPath = path.join(SKINS_DIR, filename);
    
    fs.renameSync(req.file.path, destPath);
    
    res.json({ 
      success: true, 
      message: '上传成功',
      url: `http://localhost:${PORT}/assets/skins/${filename}`
    });
  } catch (e) {
    console.error('上传背景图失败:', e);
    res.status(500).json({ success: false, message: '上传失败' });
  }
});

app.post('/api/download/audio', async (req, res) => {
  const { url, filename, audioId } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, message: '缺少URL' });
  }

  const ext = url.includes('.wav') ? '.wav' : '.mp3';
  const finalFilename = filename || `audio-${Date.now()}${ext}`;
  const filePath = path.join(AUDIO_DIR, finalFilename);

  try {
    await downloadFile(url, filePath);
    res.json({
      success: true,
      localUrl: `http://localhost:${PORT}/assets/audio/${finalFilename}`,
      filename: finalFilename
    });
  } catch (e) {
    console.error('下载音频失败:', e);
    res.status(500).json({ success: false, message: '下载失败: ' + e.message });
  }
});

app.post('/api/merge-audio', async (req, res) => {
  const { urls, filename } = req.body;
  
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, message: '缺少音频URL列表' });
  }

  const finalFilename = filename || `merged-${Date.now()}.mp3`;
  const outputPath = path.join(AUDIO_DIR, finalFilename);

  try {
    const tempFiles = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!url || !url.startsWith('http')) continue;
      
      const ext = url.includes('.wav') ? '.wav' : url.includes('.bin') ? '.bin' : '.mp3';
      const tempFile = path.join(AUDIO_DIR, `temp-${Date.now()}-${i}${ext}`);
      
      try {
        await downloadFile(url, tempFile);
        tempFiles.push(tempFile);
        console.log(`下载音频片段 ${i + 1}/${urls.length}: ${url}`);
      } catch (e) {
        console.error(`下载音频片段失败 ${i + 1}:`, e.message);
      }
    }

    if (tempFiles.length === 0) {
      return res.status(500).json({ success: false, message: '所有音频片段下载失败' });
    }

    if (tempFiles.length === 1) {
      fs.renameSync(tempFiles[0], outputPath);
      return res.json({
        success: true,
        localUrl: `http://localhost:${PORT}/assets/audio/${finalFilename}`,
        filename: finalFilename
      });
    }

    const buffers = [];
    for (const tempFile of tempFiles) {
      const buffer = fs.readFileSync(tempFile);
      buffers.push(buffer);
      fs.unlinkSync(tempFile);
    }

    const mergedBuffer = Buffer.concat(buffers);
    fs.writeFileSync(outputPath, mergedBuffer);

    console.log(`合并完成: ${tempFiles.length} 个片段 -> ${finalFilename}`);
    
    res.json({
      success: true,
      localUrl: `http://localhost:${PORT}/assets/audio/${finalFilename}`,
      filename: finalFilename,
      segments: tempFiles.length
    });
  } catch (e) {
    console.error('合并音频失败:', e);
    res.status(500).json({ success: false, message: '合并失败: ' + e.message });
  }
});

app.post('/api/download/image', async (req, res) => {
  const { url, filename } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, message: '缺少URL' });
  }

  const ext = url.includes('.png') ? '.png' : '.jpg';
  const finalFilename = filename || `image-${Date.now()}${ext}`;
  const filePath = path.join(IMAGES_DIR, finalFilename);

  try {
    await downloadFile(url, filePath);
    res.json({
      success: true,
      localUrl: `http://localhost:${PORT}/assets/images/${finalFilename}`,
      filename: finalFilename
    });
  } catch (e) {
    console.error('下载图片失败:', e);
    res.status(500).json({ success: false, message: '下载失败: ' + e.message });
  }
});

app.post('/api/upload/audio', (req, res) => {
  const { data, filename, audioId } = req.body;
  
  if (!data) {
    return res.status(400).json({ success: false, message: '缺少数据' });
  }

  const ext = filename && filename.includes('.wav') ? '.wav' : '.mp3';
  const finalFilename = filename || `audio-${Date.now()}${ext}`;
  const filePath = path.join(AUDIO_DIR, finalFilename);

  try {
    const base64Data = data.replace(/^data:audio\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    res.json({
      success: true,
      localUrl: `http://localhost:${PORT}/assets/audio/${finalFilename}`,
      filename: finalFilename
    });
  } catch (e) {
    console.error('上传音频失败:', e);
    res.status(500).json({ success: false, message: '上传失败' });
  }
});

app.post('/api/upload/image', (req, res) => {
  const { data, filename } = req.body;
  
  if (!data) {
    return res.status(400).json({ success: false, message: '缺少数据' });
  }

  const ext = filename && filename.includes('.png') ? '.png' : '.jpg';
  const finalFilename = filename || `image-${Date.now()}${ext}`;
  const filePath = path.join(IMAGES_DIR, finalFilename);

  try {
    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    res.json({
      success: true,
      localUrl: `http://localhost:${PORT}/assets/images/${finalFilename}`,
      filename: finalFilename
    });
  } catch (e) {
    console.error('上传图片失败:', e);
    res.status(500).json({ success: false, message: '上传失败' });
  }
});

app.delete('/api/audio/:filename', (req, res) => {
  const filePath = path.join(AUDIO_DIR, req.params.filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: '文件不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

app.delete('/api/image/:filename', (req, res) => {
  const filePath = path.join(IMAGES_DIR, req.params.filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: '文件不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

// 扫描本地图片文件夹
app.get('/api/scan/images', (req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR);
    const images = files
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => ({
        filename: f,
        url: `http://localhost:${PORT}/assets/images/${f}`,
        createdAt: fs.statSync(path.join(IMAGES_DIR, f)).mtime.getTime()
      }));
    res.json({ success: true, images });
  } catch (e) {
    res.status(500).json({ success: false, message: '扫描失败' });
  }
});

// 扫描本地音频文件夹
app.get('/api/scan/audio', (req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    const audios = files
      .filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f))
      .map(f => ({
        filename: f,
        url: `http://localhost:${PORT}/assets/audio/${f}`,
        createdAt: fs.statSync(path.join(AUDIO_DIR, f)).mtime.getTime()
      }));
    res.json({ success: true, audios });
  } catch (e) {
    res.status(500).json({ success: false, message: '扫描失败' });
  }
});

// 扫描皮肤图片文件夹
app.get('/api/scan/skin-images', (req, res) => {
  try {
    const files = fs.readdirSync(SKIN_IMAGES_DIR);
    const images = files
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => ({
        filename: f,
        url: `http://localhost:${PORT}/assets/skin-images/${f}`,
        type: f.toLowerCase().includes('bg') || f.toLowerCase().includes('background') ? 'background' : 'decoration',
        createdAt: fs.statSync(path.join(SKIN_IMAGES_DIR, f)).mtime.getTime()
      }));
    res.json({ success: true, images });
  } catch (e) {
    res.status(500).json({ success: false, message: '扫描失败' });
  }
});

// 上传皮肤图片
app.post('/api/upload/skin-image', async (req, res) => {
  try {
    const { data, filename, type } = req.body;
    
    if (!data || !filename) {
      return res.status(400).json({ success: false, message: '缺少参数' });
    }
    
    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    const filePath = path.join(SKIN_IMAGES_DIR, filename);
    
    fs.writeFileSync(filePath, base64Data, 'base64');
    
    res.json({ 
      success: true, 
      url: `http://localhost:${PORT}/assets/skin-images/${filename}`,
      type: type || 'decoration'
    });
  } catch (e) {
    res.status(500).json({ success: false, message: '上传失败' });
  }
});

// 删除皮肤图片
app.delete('/api/skin-image/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(SKIN_IMAGES_DIR, filename);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: '文件不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filePath);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, filePath).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

app.post('/api/workflows/:id/run', async (req, res) => {
  const workflowId = req.params.id;
  const inputs = req.body;
  
  const config = loadConfig();
  const workflow = config.workflows?.find(w => w.id === workflowId);
  
  if (!workflow) {
    return res.status(404).json({ error: '工作流不存在' });
  }
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    const response = await fetch('https://create-xumi.guangzi.qq.com/v1/workflows/run', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${workflow.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs,
        response_mode: 'streaming',
        user: 'radio_client'
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      res.write(`data: ${JSON.stringify({ event: 'error', message: errorText })}\n\n`);
      return res.end();
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let outputs = null;
    let data = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      data += decoder.decode(value, { stream: true });
      const lines = data.split('\n');
      data = lines.pop() || '';
      
      for (const line of lines) {
        if (!line || !line.startsWith('data:')) continue;
        let payload = line;
        while (payload.startsWith('data:')) {
          payload = payload.slice(5).trim();
        }
        try {
          const obj = JSON.parse(payload);
          
          if (obj.event === 'node_started' || obj.event === 'node_finished') {
            const nodeName = obj.data?.node_id || obj.data?.title || '未知节点';
            res.write(`data: ${JSON.stringify({ 
              event: obj.event, 
              node: nodeName,
              title: obj.data?.title || ''
            })}\n\n`);
          }
          
          if (obj.event === 'workflow_finished') {
            outputs = obj.data?.outputs;
          }
        } catch (e) {}
      }
    }
    
    if (!outputs) {
      res.write(`data: ${JSON.stringify({ event: 'error', message: '工作流未返回有效输出' })}\n\n`);
      return res.end();
    }
    
    res.write(`data: ${JSON.stringify({ event: 'processing', message: '正在处理音频...' })}\n\n`);
    
    let audioUrls = [];
    if (outputs.merged_url) {
      if (Array.isArray(outputs.merged_url)) {
        audioUrls = outputs.merged_url.filter(url => url && url.startsWith('http'));
      } else if (typeof outputs.merged_url === 'string') {
        audioUrls = [outputs.merged_url];
      }
    }
    
    if (audioUrls.length === 0) {
      const outputText = JSON.stringify(outputs);
      const audioUrlMatch = outputText.match(/https:\/\/[^\s"]+\.(mp3|wav|bin)[^\s"]*/gi);
      if (audioUrlMatch) {
        audioUrls = audioUrlMatch;
      }
    }
    
    let audioUrl = '';
    if (audioUrls.length > 1) {
      res.write(`data: ${JSON.stringify({ event: 'processing', message: `正在合并 ${audioUrls.length} 个音频片段...` })}\n\n`);
      const buffers = [];
      for (let i = 0; i < audioUrls.length; i++) {
        const url = audioUrls[i];
        if (!url || !url.startsWith('http')) continue;
        try {
          res.write(`data: ${JSON.stringify({ event: 'processing', message: `下载音频片段 ${i + 1}/${audioUrls.length}...` })}\n\n`);
          const audioResp = await fetch(url);
          const buffer = Buffer.from(await audioResp.arrayBuffer());
          buffers.push(buffer);
        } catch (e) {
          console.error('下载音频片段失败:', e.message);
        }
      }
      if (buffers.length > 0) {
        const mergedBuffer = Buffer.concat(buffers);
        const filename = `${workflow.name}-${Date.now()}.mp3`;
        const filePath = path.join(AUDIO_DIR, filename);
        fs.writeFileSync(filePath, mergedBuffer);
        audioUrl = `http://localhost:${PORT}/assets/audio/${filename}`;
      }
    } else if (audioUrls.length === 1) {
      res.write(`data: ${JSON.stringify({ event: 'processing', message: '正在下载音频...' })}\n\n`);
      const audioResp = await fetch(audioUrls[0]);
      const buffer = Buffer.from(await audioResp.arrayBuffer());
      const ext = audioUrls[0].includes('.wav') ? '.wav' : '.mp3';
      const filename = `${workflow.name}-${Date.now()}${ext}`;
      const filePath = path.join(AUDIO_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      audioUrl = `http://localhost:${PORT}/assets/audio/${filename}`;
    }
    
    res.write(`data: ${JSON.stringify({ event: 'finished', audioUrl, outputs })}\n\n`);
    res.end();
    
  } catch (e) {
    console.error('工作流运行失败:', e);
    res.write(`data: ${JSON.stringify({ event: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`赛博电台后端服务运行在 http://localhost:${PORT}`);
  console.log(`- 前端页面: http://localhost:${PORT}/admin.html`);
  console.log(`- 用户页面: http://localhost:${PORT}/index.html`);
});
