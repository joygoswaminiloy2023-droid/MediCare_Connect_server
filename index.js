const express = require("express");
const cors = require("cors");
const { connectToDatabase } = require("./lib/db");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ─── CORS CONFIGURATION ──────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  optionsSuccessStatus: 204
}));

// ─── ROOT ROUTE ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to MediCare Connect API",
    version: "1.0.0",
    status: "Server is running",
    endpoints: {
      health: "/api/health",
      doctors: "/api/doctors",
      admin: "/api/admin",
      appointments: "/api/appointments",
      patients: "/api/patients",
      users: "/api/users"
    }
  });
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.command({ ping: 1 });
    
    res.status(200).json({
      success: true,
      status: "healthy",
      message: "Server and database are running",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(500).json({
      success: false,
      status: "unhealthy",
      message: "Database connection failed"
    });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────
const appointmentRoutes = require("./routes/appointments");
app.use("/api/appointments/webhook", express.raw({ type: "application/json" }));

// ─── JSON PARSER ─────────────────────────────────────────────────────
app.use(express.json());

// ─── ROUTES ──────────────────────────────────────────────────────────
try {
  const doctorRoutes = require("./routes/doctor");
  const adminRoutes = require("./routes/admin");
  const patientRoutes = require("./routes/patient");
  const userRoutes = require("./routes/users");

  app.use("/api/doctors", doctorRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/appointments", appointmentRoutes);
  app.use("/api/patients", patientRoutes);
  app.use("/api/users", userRoutes);
  
  console.log("Routes loaded successfully");
} catch (error) {
  console.error("Route loading error:", error);
}

// ─── 404 HANDLER ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    availableEndpoints: [
      "/",
      "/api/health",
      "/api/doctors",
      "/api/admin",
      "/api/appointments",
      "/api/patients",
      "/api/users"
    ]
  });
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

// ─── DATABASE CONNECTION ─────────────────────────────────────────────
let dbConnected = false;
let connectionPromise = null;

async function ensureDbConnection() {
  if (dbConnected) return;
  if (connectionPromise) return connectionPromise;
  
  connectionPromise = connectToDatabase()
    .then(() => {
      dbConnected = true;
      console.log("Database connected successfully");
    })
    .catch((err) => {
      console.error("Database connection failed:", err);
      throw err;
    })
    .finally(() => {
      connectionPromise = null;
    });
  
  return connectionPromise;
}

// ─── START SERVER (Local) ────────────────────────────────────────────
if (require.main === module) {
  connectToDatabase()
    .then(() => {
      console.log(" Database connected successfully");
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/api/health`);
      });
    })
    .catch((err) => {
      console.error("Database connection failed:", err);
      app.listen(PORT, () => {
        console.log(`Server running WITHOUT database on port ${PORT}`);
      });
    });
}

// ─── EXPORT FOR VERCEL ──────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    await ensureDbConnection();
    return app(req, res);
  } catch (error) {
    console.error("Vercel handler error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
};