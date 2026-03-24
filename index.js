require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { startBackgroundProcessor } = require("./services/background-processor");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS Configuration ──────────────────────────────────────────
// [B3] FIX: Web domain added to allowed origins for web migration.
// Origins are configurable via CORS_ALLOWED_ORIGINS env var (comma-separated).
const defaultOrigins = [
  "https://api.cloopapp.com",
  "https://app.cloopapp.com", // Web frontend
  "http://localhost:3000",     // Local dev
  "http://localhost:3001",     // Local dev (alt port)
];

const envOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// ─── Body Parsing ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── API Route Registration ──────────────────────────────────────
app.use("/api/login", require("./api/login/login"));
app.use("/api/signup", require("./api/signup/signup"));
app.use("/api/profile", require("./api/profile/profile"));
app.use("/api/chapters", require("./api/chapters/chapters"));
app.use("/api/topics", require("./api/topics/topics"));
app.use("/api/topic-chats", require("./api/topic-chats/topic-chats"));
app.use("/api/normal-chat", require("./api/normal-chat/normal-chat"));
app.use("/api/content-generation", require("./api/content-generation/content-generation"));
app.use("/api/saved-topics", require("./api/saved-topics/saved-topics"));
app.use("/api/notifications", require("./api/notifications/notifications"));

// ─── 404 Handler ─────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// ─── Global Error Handler ────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ─── Start Server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Cloop] Server running on port ${PORT}`);
  console.log(`[Cloop] Allowed CORS origins: ${allowedOrigins.join(", ")}`);

  // Start the background content generation processor
  startBackgroundProcessor();
});
