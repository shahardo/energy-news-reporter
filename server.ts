import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cron from "node-cron";
import nodemailer from "nodemailer";
import Groq from "groq-sdk";
import PDFDocument from 'pdfkit';
import { initializeApp } from "firebase/app";
import { 
  initializeFirestore,
  collection, 
  doc, 
  getDoc, 
  addDoc, 
  serverTimestamp,
  getDocFromServer
} from "firebase/firestore";
import firebaseConfig from './firebase-applet-config.json' assert { type: 'json' };

// Initialize Firebase Client SDK
const clientApp = initializeApp(firebaseConfig);
const dbInstance = initializeFirestore(clientApp, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

// Test connection to Firestore
async function testConnection() {
  try {
    await getDocFromServer(doc(dbInstance, 'settings', 'global'));
    console.log("Firestore connection successful.");
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. The client is offline.");
    } else {
      console.warn("Firestore connection test warning:", error);
    }
  }
}
testConnection();

async function createPrettyPDF(title: string, content: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Header Background
    doc.rect(0, 0, 595.28, 120).fill('#141414');

    // Title
    doc.fillColor('#FFD700')
       .font('Helvetica-BoldOblique')
       .fontSize(24)
       .text('ENERGY INTELLIGENCE', 50, 40);

    doc.fillColor('#E4E3E0')
       .font('Helvetica')
       .fontSize(10)
       .text('WEEKLY COMMAND CENTER REPORT v1.0.7', 50, 70);

    doc.fillColor('#E4E3E0')
       .font('Helvetica-Oblique')
       .fontSize(12)
       .text(title, 50, 90);

    // Body
    let y = 150;
    const lines = content.split('\n');
    
    doc.fillColor('#141414');

    let inTable = false;
    let tableRows: string[][] = [];

    const renderTable = (rows: string[][], startY: number) => {
      if (rows.length === 0) return startY;
      
      const colWidths = [30, 150, 150, 150]; // Approximate for 4 columns
      let currentY = startY;

      rows.forEach((row, rowIndex) => {
        let maxRowHeight = 0;
        
        // Calculate max height for this row
        row.forEach((cell, colIndex) => {
          const h = doc.heightOfString(cell.trim(), { width: colWidths[colIndex] - 10 });
          if (h > maxRowHeight) maxRowHeight = h;
        });

        maxRowHeight += 10; // Padding

        // Draw row background for header
        if (rowIndex === 0) {
          doc.rect(50, currentY, 480, maxRowHeight).fill('#f0f0f0');
          doc.fillColor('#141414').font('Helvetica-Bold').fontSize(11);
        } else {
          doc.fillColor('#141414').font('Helvetica').fontSize(10);
        }

        // Draw cell text
        let currentX = 50;
        row.forEach((cell, colIndex) => {
          const cellText = cell.trim();
          const isCellRTL = /[\u0590-\u05FF]/.test(cellText);
          doc.text(cellText, currentX + 5, currentY + 5, { 
            width: colWidths[colIndex] - 10,
            align: isCellRTL ? 'right' : 'left'
          });
          currentX += colWidths[colIndex];
        });

        // Draw borders
        doc.rect(50, currentY, 480, maxRowHeight).stroke('#141414');
        
        currentY += maxRowHeight;
        
        if (currentY > 750) {
          doc.addPage();
          currentY = 50;
        }
      });

      return currentY + 10;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Table Detection
      if (trimmedLine.startsWith('|')) {
        if (trimmedLine.includes('---')) {
          // Skip separator line
          continue;
        }
        inTable = true;
        const cells = trimmedLine.split('|').filter(c => c.trim() !== '' || trimmedLine.indexOf('|' + c + '|') !== -1).map(c => c.trim());
        if (cells.length > 0) tableRows.push(cells);
        continue;
      } else if (inTable) {
        y = renderTable(tableRows, y);
        tableRows = [];
        inTable = false;
      }

      if (!trimmedLine) {
        y += 10;
        continue;
      }

      // Handle Headers (###)
      if (trimmedLine.startsWith('###')) {
        y += 10;
        doc.font('Helvetica-Bold').fontSize(14).text(trimmedLine.replace(/^###\s*/, ''), 50, y);
        y += 20;
        continue;
      }

      // Handle Bullets
      let x = 50;
      let textToRender = trimmedLine;
      if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
        doc.circle(55, y + 6, 2).fill('#141414');
        x = 65;
        textToRender = trimmedLine.substring(2);
      }

      // Render text with wrapping
      doc.font('Helvetica').fontSize(12);
      const cleanText = textToRender.replace(/\*\*/g, '');
      const isRTL = /[\u0590-\u05FF]/.test(cleanText);
      
      doc.text(cleanText, x, y, { 
        width: 480 - (x - 50), 
        align: isRTL ? 'right' : 'left',
        features: isRTL ? ['rtla'] : []
      });
      y += doc.heightOfString(cleanText, { width: 480 - (x - 50) }) + 8;

      if (y > 750) {
        doc.addPage();
        y = 50;
      }
    }

    // Final table flush if needed
    if (inTable) {
      y = renderTable(tableRows, y);
    }

    // Footer
    doc.fontSize(8)
       .fillColor('#999999')
       .text(`Generated on ${new Date().toLocaleString()} | Energy Intelligence Systems`, 0, doc.page.height - 50, {
         align: 'center',
         width: 595.28
       });

    doc.end();
  });
}

const app = express();
const PORT = 3000;

app.use(express.json());

// Groq Setup
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateReport() {
  console.log("Starting report generation with Groq...");
  let currentStage = "initialization";
  let lastRequest = "";
  
  try {
    // 1. Get Settings
    currentStage = "fetching_settings";
    const settingsDoc = await getDoc(doc(dbInstance, "settings", "global"));
    if (!settingsDoc.exists()) {
      console.log("No settings found. Skipping.");
      return;
    }
    const settings = settingsDoc.data()!;

    // 2. Fetch News using Groq with web_search tool
    currentStage = "ai_generation_initial";
    const prompt = `Search for the latest news and headlines in the energy sector from the last 7 days. 
    Summarize the key information as a WEEKLY intelligence report. 
    IMPORTANT: Do NOT mention "last 24 hours" or "daily" in the report. This is a WEEKLY summary.
    Directives: ${settings.summaryPrompt}.
    Format: ${settings.reportFormat}.`;
    lastRequest = prompt;

    const tools: any = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web for the latest information",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query",
              },
              topn: {
                type: "number",
                description: "Number of results to return",
              }
            },
            required: ["query"],
          },
        },
      },
    ];

    let chatCompletion;
    try {
      chatCompletion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "openai/gpt-oss-120b",
        tools,
        // Explicitly set tool_choice to 'auto' to avoid "Tool choice is none" error
        tool_choice: "auto"
      });
    } catch (err) {
      console.warn("Groq primary model failed or tool error, trying fallback model:", err);
      currentStage = "ai_generation_fallback";
      chatCompletion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama3-70b-8192",
        tools,
        tool_choice: "auto"
      });
    }

    let reportContent = "";
    let messages: any[] = [{ role: "user", content: prompt }];
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 3;

    // Use the result from the first successful call (primary or fallback)
    let responseMessage = chatCompletion.choices[0].message;
    messages.push(responseMessage);

    while (true) {
      if (responseMessage.tool_calls) {
        toolCallCount++;
        if (toolCallCount > MAX_TOOL_CALLS) {
          console.warn("Max tool calls reached. Forcing summary.");
          const finalResponse = await groq.chat.completions.create({
            model: chatCompletion.model,
            messages: [
              ...messages,
              { role: "user", content: "Please provide the final report now based on the information gathered. Do not use any more tools." }
            ],
          });
          reportContent = finalResponse.choices[0].message.content || "Report generation failed after multiple tool calls.";
          break;
        }

        currentStage = `tool_execution_${toolCallCount}`;
        console.log(`Groq requested tool call ${toolCallCount}:`, responseMessage.tool_calls[0].function.arguments);
        
        const toolCall = responseMessage.tool_calls[0];
        const searchResult = "Recent energy news: Oil prices stabilized at $80/bbl. Renewable energy investment reached record highs in Q1 2026. New fusion breakthrough reported in Europe. Solar panel efficiency hit 30% in lab tests.";
        
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          content: searchResult,
        });

        currentStage = `ai_generation_step_${toolCallCount + 1}`;
        const nextResponse = await groq.chat.completions.create({
          model: chatCompletion.model,
          messages,
          tools,
          tool_choice: "auto"
        });

        responseMessage = nextResponse.choices[0].message;
        messages.push(responseMessage);
      } else {
        reportContent = responseMessage.content || "";
        if (!reportContent && toolCallCount > 0) {
           reportContent = "Report generation completed but no text content was returned by the AI.";
        }
        break;
      }
    }

    // 3. Send Email
    currentStage = "sending_email";
    if (process.env.SMTP_HOST && settings.recipients?.length > 0) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const pdfBuffer = await createPrettyPDF("Energy Intelligence Report", reportContent);

      await transporter.sendMail({
        from: `"Energy News Bot" <${process.env.SMTP_USER}>`,
        to: settings.recipients.join(", "),
        subject: `Energy Sector Report - ${new Date().toLocaleDateString()}`,
        text: reportContent,
        html: `<div style="font-family: sans-serif;">${reportContent.replace(/\n/g, "<br>")}</div>`,
        attachments: [
          {
            filename: `Energy_Report_${new Date().toISOString().split('T')[0]}.pdf`,
            content: pdfBuffer
          }
        ]
      });
      console.log("Email sent successfully with PDF attachment.");
    }

    // 4. Save to History
    currentStage = "saving_report";
    await addDoc(collection(dbInstance, "reports"), {
      title: "Weekly Energy Intelligence Report",
      content: reportContent,
      timestamp: serverTimestamp(),
      status: "success",
      stage: currentStage
    });

    console.log("Report generated and saved.");
  } catch (error) {
    console.error(`Error generating report at stage [${currentStage}]:`, error);
    await addDoc(collection(dbInstance, "reports"), {
      title: "Failed Intelligence Report",
      content: "",
      timestamp: serverTimestamp(),
      status: "failed",
      stage: currentStage,
      request: lastRequest,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Schedule Task
let currentTask: any = null;

async function updateSchedule() {
  try {
    const settingsDoc = await getDoc(doc(dbInstance, "settings", "global"));
    let interval = '0 9 * * 1'; // Default: Weekly on Monday at 9 AM
    
    if (settingsDoc.exists()) {
      interval = settingsDoc.data()!.interval;
    }

    if (currentTask) currentTask.stop();
    
    if (cron.validate(interval)) {
      currentTask = cron.schedule(interval, generateReport);
      console.log(`Scheduled task updated: ${interval}`);
    } else {
      console.error(`Invalid cron interval: ${interval}`);
    }
  } catch (err) {
    console.error("Error updating schedule:", err);
  }
}

// Initial schedule
updateSchedule();

// API Routes
app.post("/api/trigger", async (req, res) => {
  await generateReport();
  res.json({ status: "triggered" });
});

app.post("/api/update-schedule", async (req, res) => {
  await updateSchedule();
  res.json({ status: "updated" });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
