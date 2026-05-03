require('dotenv').config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dns = require('dns');
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// 1. FIXED CORS: Added 'ngrok-skip-browser-warning' to allowed headers
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// DB connect
dns.setDefaultResultOrder('ipv4first');
mongoose.connect(process.env.MONGO_URL)
.then(() => console.log("DB connected"))
.catch(err => console.log("DB connection error:", err));

// Schemas
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const User = mongoose.model("User", UserSchema);

const PostSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  caption: String,
  image: String,

  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  comments: [
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    text: String,
    createdAt: { type: Date, default: Date.now }
  }
],
}, { timestamps: true });
const Post = mongoose.model("Post", PostSchema);

// Multer Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Auth Middleware
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send("No token");
    const token = authHeader.split(" ")[1];
    // Use fallback secret if .env isn't loaded properly
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = { userId: decoded.userId };
    next();
  } catch (err) {
    res.status(401).send("Invalid token");
  }
};

// Routes
app.get("/", (req, res) => res.send("Server is running 🚀"));

app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).send("User already exists");
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword });
    await user.save();
    res.send("User registered successfully ✅");
  } catch (err) { res.status(500).send(err.message); }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).send("User not found");
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send("Wrong password");
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: "1d" });
    res.send({ token });
  } catch (err) { res.status(500).send(err.message); }
});

app.post("/comment", authMiddleware, async (req, res) => {
  try {
    const { postId, text } = req.body;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).send("Post not found");

    post.comments.push({
      userId: req.user.userId,
      text,
    });

    await post.save();

const updatedPost = await Post.findById(postId)
  .populate("userId", "name")
  .populate("comments.userId", "name");

io.emit("new-comment", updatedPost);
res.json(updatedPost);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/profile", authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.userId).select("-password");
  res.send(user);
});

// FIXED: Variable naming conflicts and user ID reference
app.post("/create-post", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Image is required");

    const newPost = new Post({
      caption: req.body.caption,
      // Constructs the image URL based on the current host (ngrok or localhost)
      image: "https://" + req.get("host") + "/uploads/" + req.file.filename,
      userId: req.user.userId
    });

    await newPost.save();

// 🔥 IMPORTANT FIX (ADD THIS)
const populatedPost = await Post.findById(newPost._id)
  .populate("userId", "name");

// 🔥 EMIT EVENT
io.emit("new_post", populatedPost);

res.json(populatedPost);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});
app.put("/like", authMiddleware, async (req, res) => {
  try {
    const { postId } = req.body;
    const userId = req.user.userId; // 🔥 VERY IMPORTANT

    const post = await Post.findById(postId);

    if (!post) return res.status(404).send("Post not found");

    if (post.likes.includes(userId)) {
      // unlike
      post.likes = post.likes.filter(id => id.toString() !== userId);
    } else {
      // like
      post.likes.push(userId);
    }

    await post.save();

    const updatedPost = await Post.findById(postId).populate("userId", "name");

    io.emit("update-like", updatedPost);
    res.json(updatedPost);

  } catch (err) {
    console.log(err);
    res.status(500).send("Server error");
  }
});

app.get("/posts", async (req, res) => {
  try {
    const posts = await Post.find().populate("userId", "name email").populate("comments.userId", "name").sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) { res.status(500).send(err.message); }
});

app.delete("/delete-post/:id", authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).send("Post not found");
    if (post.userId.toString() !== req.user.userId) return res.status(403).send("Not allowed");
    await Post.findByIdAndDelete(req.params.id);
    res.send("Post deleted successfully 🗑️");
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});