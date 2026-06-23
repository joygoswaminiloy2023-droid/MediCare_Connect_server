const express = require("express");
const cors = require("cors");
const { connectToDatabase } = require("./lib/db");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. CORS
// ==========================================
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true
}));

// ==========================================
// 2. ⚠️ Stripe webhook MUST come BEFORE express.json()
// Raw body is required for Stripe signature verification
// ==========================================
const appointmentRoutes = require("./routes/appointments");
app.use("/api/appointments/webhook", express.raw({ type: "application/json" }));

// ==========================================
// 3. JSON middleware (after webhook raw route)
// ==========================================
app.use(express.json());

// ==========================================
// 4. Mount all routes after DB connects
// ==========================================
connectToDatabase()
  .then(() => {

    // Doctor routes
    const doctorRoutes = require("./routes/doctor");
    app.use("/api/doctors", doctorRoutes);

    // Admin routes
    const adminRoutes = require("./routes/admin");
    app.use("/api/admin", adminRoutes);

    // ✅ Appointment + Payment + Stripe routes
    app.use("/api/appointments", appointmentRoutes);

    // ==========================================
    app.listen(PORT, () => {
      console.log(`Backend server online at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Critical failure initializing database:", err);
    process.exit(1);
  });