const express = require("express");
const cors = require("cors");
const { connectToDatabase } = require("./lib/db");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. Optimized Core Middlewares (Fixed CORS policy)
// ==========================================
app.use(cors({ 
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true // Allows cookies and auth headers to pass through cleanly
})); 
app.use(express.json());

// ==========================================
// 2. Initialize Database and mount routes
// ==========================================
connectToDatabase()
  .then(() => {
    // Doctor Routes
    const doctorRoutes = require("./routes/doctor");
    app.use("/api/doctors", doctorRoutes);

    // ==========================================
    // 🛡️ NEW ADMIN REQUISITES & ROUTE SECURITY
    // ==========================================
    
    // Role-based authorization middleware guard (Challenge 3 Compliance)
    const verifyAdmin = (req, res, next) => {
      // Access allowed only if req.user exists and has an 'admin' role value
      if (req.user?.role !== "admin") {
        return res.status(403).json({ message: "Access forbidden. Administration clearance required." });
      }
      next();
    };

    // Require and mount the admin routing module
    const adminRoutes = require("./routes/admin");
    
    /**
     * NOTE FOR CHALLENGE 3: 
     * Once your JWT verification middleware file is complete, uncomment the two lines below 
     * to enforce strict security token verification before checking the user's role:
     * * const verifyToken = require("./middleware/verifyToken");
     * app.use("/api/admin", verifyToken, verifyAdmin, adminRoutes);
     */

    // Active developmental path (allows testing before JWT middleware hookup)
    app.use("/api/admin", adminRoutes);

    // ==========================================

    app.listen(PORT, () => {
      console.log(`Backend server execution online at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Critical failure initializing database connection pool:", err);
    process.exit(1);
  });