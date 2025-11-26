require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use('/uploads', express.static('uploads'));

// MongoDB Connect
mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('MongoDB connected'));

// Schemas
const conversationSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  userId: String,
  title: { type: String, default: '新对话' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isDeleted: { type: Boolean, default: false }
});

const messageSchema = new mongoose.Schema({
  sessionId: String,
  role: { type: String, enum: ['user', 'assistant', 'gemini3'], required: true },
  content: String,
  attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' }],
  senderAi: String,
  createdAt: { type: Date, default: Date.now }
});

const attachmentSchema = new mongoose.Schema({
  sessionId: String,
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  fileName: String,
  fileType: String,
  fileSize: Number,
  filePath: String,
  uploadedAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema);
const Message = mongoose.model('Message', messageSchema);
const Attachment = mongoose.model('Attachment', attachmentSchema);

// 文件上传配置
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('不支持的文件格式'), false);
  }
});

// ---------- 接口实现 ----------

// 1. 文件上传
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ code: 400, msg: '请上传文件' });

    const attachment = await Attachment.create({
      sessionId: req.body.sessionId || null,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      filePath: `/uploads/${req.file.filename}`
    });

    res.json({
      code: 0,
      msg: '上传成功',
      data: {
        fileId: attachment._id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        fileSize: attachment.fileSize,
        url: `http://localhost:${PORT}${attachment.filePath}`
      }
    });
  } catch (err) {
    if (err.message === '不支持的文件格式') return res.status(415).json({ code: 415, msg: err.message });
    res.status(500).json({ code: 500, msg: '上传失败' });
  }
});

// 2. 指令下发（调用 Gemini3）
app.post('/api/gemini3/chat', async (req, res) => {
  const { sessionId, message, attachments = [] } = req.body;
  if (!sessionId || !message) return res.status(400).json({ code: 400, msg: 'sessionId 和 message 必填' });

  try {
    // 保存用户消息
    const userMsg = await Message.create({
      sessionId,
      role: 'user',
      content: message,
      attachments: attachments.filter(Boolean)
    });

    // 调用 Gemini API（这里以 gemini-1.5-pro 为例）
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: message }] }]
      }
    );

    const geminiText = geminiRes.data.candidates[0].content.parts[0].text || '（无回复）';

    // 保存 Gemini 回复
    const geminiMsg = await Message.create({
      sessionId,
      role: 'gemini3',
      content: geminiText,
      senderAi: 'gemini-1.5-pro'
    });

    // 更新或创建会话
    await Conversation.updateOne(
      { sessionId },
      { $set: { updatedAt: new Date(), title: message.substring(0, 30) } },
      { upsert: true }
    );

    res.json({
      code: 0,
      msg: 'success',
      data: {
        sessionId,
        messageId: geminiMsg._id,
        role: 'gemini3',
        content: geminiText,
        createdAt: geminiMsg.createdAt
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: 'Gemini3 服务异常' });
  }
});

// 3. 获取对话列表（分页+搜索）
app.get('/api/conversations', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const keyword = req.query.keyword || '';

  const filter = { isDeleted: false };
  if (keyword) filter.title = { $regex: keyword, $options: 'i' };

  const total = await Conversation.countDocuments(filter);
  const list = await Conversation.find(filter)
    .sort({ updatedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select('sessionId title updatedAt');

  const enriched = await Promise.all(list.map(async (conv) => {
    const count = await Message.countDocuments({ sessionId: conv.sessionId });
    return { ...conv._doc, messageCount: count };
  }));

  res.json({
    code: 0,
    msg: 'success',
    data: {
      list: enriched,
      pagination: { page, limit, total, hasMore: page * limit < total }
    }
  });
});

// 4. 获取单会话消息
app.get('/api/conversations/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params;
  const messages = await Message.find({ sessionId })
    .sort({ createdAt: 1 })
    .populate('attachments');

  const result = messages.map(m => ({
    messageId: m._id,
    role: m.role,
    content: m.content,
    attachments: (m.attachments || []).map(a => ({
      fileId: a._id,
      fileName: a.fileName,
      url: `http://localhost:${PORT}${a.filePath}`
    })),
    createdAt: m.createdAt
  }));

  res.json({ code: 0, msg: 'success', data: result });
});

// Start
app.listen(PORT, () => {
  console.log(`Gemini3 后端已启动：http://localhost:${PORT}`);
  console.log(`上传测试：curl -F "file=@./test.png" http://localhost:${PORT}/api/upload`);
});
