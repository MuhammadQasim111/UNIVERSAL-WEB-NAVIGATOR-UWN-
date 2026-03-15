import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { chromium, Browser, Page, BrowserContext } from "playwright";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Session management
interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<string, BrowserSession>();

async function ensureSession(id: string, url?: string): Promise<BrowserSession> {
  let session = sessions.get(id);
  if (!session) {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const vw = 1280;
    const vh = 800;
    const context = await browser.newContext({ 
      viewport: { width: vw, height: vh },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle' });
    }
    session = { browser, context, page };
    sessions.set(id, session);
  }
  return session;
}

// API Routes
app.post("/api/browser/init", async (req, res) => {
  const { url } = req.body;
  const sessionId = Math.random().toString(36).substring(7);
  try {
    await ensureSession(sessionId, url);
    res.json({ sessionId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/browser/screenshot", async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    // Improve dynamic content detection: wait for network idle and a short buffer
    try {
      await session.page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch (e) {
      // Ignore timeout, just proceed
    }
    await session.page.waitForTimeout(1000); // Buffer for animations

    const screenshotBuffer = await session.page.screenshot({ type: 'png' });
    res.json({ screenshot: screenshotBuffer.toString('base64'), url: session.page.url() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/browser/action", async (req, res) => {
  const { sessionId, action, x, y, text } = req.body;
  try {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const vw = 1280;
    const vh = 800;

    if (x !== undefined && y !== undefined) {
      const targetX = (x / 1000) * vw;
      const targetY = (y / 1000) * vh;

      if (action === "click") {
        await session.page.mouse.click(targetX, targetY);
      } else if (action === "type") {
        await session.page.mouse.click(targetX, targetY);
        await session.page.keyboard.type(text || "");
        await session.page.keyboard.press('Enter');
      }
    } else if (action === "wait") {
      await session.page.waitForTimeout(3000);
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/browser/close", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    await session.browser.close();
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

// 404 handler for API routes to prevent falling through to SPA fallback
app.use("/api/*", (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

startServer();

export default app;
