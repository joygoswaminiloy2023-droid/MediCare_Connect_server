const express = require("express");
const cors = require("cors");
const { connectToDatabase } = require("./lib/db");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// 1. Core Middlewares
app.use(cors({ origin: "http://localhost:3000" })); 
app.use(express.json());

// 2. Initialize Database and mount routes
connectToDatabase()
  .then(() => {
    const doctorRoutes = require("./routes/doctor");
    app.use("/api/doctors", doctorRoutes);

    app.listen(PORT, () => {
      console.log(`Backend server execution online at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Critical failure initializing database connection pool:", err);
    process.exit(1);
  });