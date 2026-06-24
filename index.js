const express = require("express");
const cors = require("cors");
const { connectToDatabase } = require("./lib/db");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true
}));

const appointmentRoutes = require("./routes/appointments");
app.use("/api/appointments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

connectToDatabase()
  .then(() => {

    const doctorRoutes = require("./routes/doctor");
    app.use("/api/doctors", doctorRoutes);

    const adminRoutes = require("./routes/admin");
    app.use("/api/admin", adminRoutes);

    app.use("/api/appointments", appointmentRoutes);

    const patientRoutes = require("./routes/patient");
    app.use("/api/patients", patientRoutes);

    // ADD THIS:
    const userRoutes = require("./routes/users");
    app.use("/api/users", userRoutes);

       app.use("/api/patients",     patientRoutes);  

    app.listen(PORT, () => {
      console.log(`Backend server online at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Critical failure initializing database:", err);
    process.exit(1);
  });