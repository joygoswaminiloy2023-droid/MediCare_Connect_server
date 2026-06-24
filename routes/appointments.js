const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../lib/db");
const { ObjectId } = require("mongodb");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// =========================================================================
// GET: Single doctor by ID (for booking page)
// =========================================================================
router.get("/doctor/:id", async (req, res) => {
  try {
    const db  = await connectToDatabase();
    const oid = new ObjectId(req.params.id);
    const doctor = await db.collection("Doctor").findOne({ _id: oid });
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found." });
    res.status(200).json({ success: true, doctor });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch doctor." });
  }
});

// =========================================================================
// POST: REQUEST APPOINTMENT (before payment)
// =========================================================================
router.post("/request", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const {
      doctorId, doctorName,
      patientId, patientEmail, patientName,
      date, timeSlot, problem
    } = req.body;

    if (!doctorId || !patientEmail || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const doctorOid = new ObjectId(doctorId);
    const patientOid = patientId ? new ObjectId(patientId) : null;
    const now = new Date();

    // Save appointment as PENDING (waiting for doctor approval)
    const appointmentDoc = {
      patientId: patientOid,
      patientEmail: patientEmail.toLowerCase(),
      patientName,
      doctorId: doctorOid,
      doctorName,
      appointmentDate: date,
      appointmentTime: timeSlot,
      appointmentStatus: "pending",
      symptoms: problem || "General consultation",
      paymentStatus: "unpaid",
      createdAt: now
    };

    const result = await db.collection("Appointments").insertOne(appointmentDoc);

    res.status(201).json({ 
      success: true, 
      message: "Appointment request sent to doctor!",
      appointmentId: result.insertedId 
    });

  } catch (error) {
    console.error("Request appointment failed:", error);
    res.status(500).json({ success: false, message: "Failed to request appointment." });
  }
});

// =========================================================================
// POST: Create Stripe checkout session + save pending appointment
// =========================================================================
router.post("/create-checkout", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const {
      doctorId, doctorName,
      patientId, patientEmail, patientName,
      date, timeSlot, problem, consultationFee
    } = req.body;

    if (!doctorId || !patientEmail || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const doctorOid  = new ObjectId(doctorId);
    const patientOid = patientId ? new ObjectId(patientId) : null;
    const fee        = Number(consultationFee) || 0;
    const now        = new Date();

    // Save appointment as pending
    const appointmentDoc = {
      patientId:         patientOid,
      patientEmail:      patientEmail.toLowerCase(),
      patientName,
      doctorId:          doctorOid,
      doctorName,
      appointmentDate:   date,
      appointmentTime:   timeSlot,
      appointmentStatus: "pending",
      symptoms:          problem || "General consultation",
      paymentStatus:     "unpaid",
      createdAt:         now
    };

    const apptResult    = await db.collection("Appointments").insertOne(appointmentDoc);
    const appointmentId = apptResult.insertedId.toString();

    // Save pending payment record
    await db.collection("Payments").insertOne({
      appointmentId:  apptResult.insertedId,
      patientId:      patientOid,
      doctorId:       doctorOid,
      amount:         fee,
      transactionId:  null,
      paymentDate:    null,
      paymentStatus:  "unpaid",
      createdAt:      now
    });

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode:                 "payment",
      customer_email:       patientEmail,
      line_items: [{
        price_data: {
          currency:     "usd",
          product_data: {
            name:        `Consultation with ${doctorName}`,
            description: `${date} at ${timeSlot} — ${problem || "General consultation"}`,
          },
          unit_amount: Math.round(fee * 100),
        },
        quantity: 1,
      }],
      metadata: { appointmentId, doctorId, patientEmail },
      success_url: `${CLIENT_URL}/appointments/success?appointmentId=${appointmentId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${CLIENT_URL}/appointments/book/${doctorId}?cancelled=true`,
    });

    res.status(200).json({ success: true, url: session.url, appointmentId });

  } catch (error) {
    console.error("Checkout creation failed:", error);
    res.status(500).json({ success: false, message: "Failed to create checkout.", error: error.message });
  }
});

// =========================================================================
// POST: Confirm appointment after Stripe redirects back
// Called from success page — verifies payment with Stripe directly
// =========================================================================
router.post("/confirm/:appointmentId", async (req, res) => {
  try {
    const db        = await connectToDatabase();
    const { sessionId } = req.body;
    const appointmentId = req.params.appointmentId;

    // Verify payment status directly with Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(402).json({ success: false, message: "Payment not completed." });
    }

    const now = new Date();

    // Update Appointments
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "confirmed",
          paymentStatus:     "paid",
          stripeSessionId:   session.id,
          confirmedAt:       now,
          amount:            session.amount_total / 100
        }
      }
    );

    // Update Payments with transaction details
    await db.collection("Payments").updateOne(
      { appointmentId: new ObjectId(appointmentId) },
      {
        $set: {
          transactionId: session.payment_intent,
          paymentDate:   now,
          paymentStatus: "paid",
          amount:        session.amount_total / 100,
          stripeSessionId: session.id
        }
      }
    );

    // Return confirmed appointment
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    res.status(200).json({ success: true, appointment });

  } catch (error) {
    console.error("Confirmation failed:", error);
    res.status(500).json({ success: false, message: "Failed to confirm appointment." });
  }
});
// =========================================================================
// GET: Appointment status by ID
// =========================================================================
router.get("/status/:appointmentId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });
    if (!appointment) return res.status(404).json({ success: false, message: "Not found." });
    res.status(200).json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch appointment." });
  }
});

// =========================================================================
// GET: Check appointment status (for polling)
// =========================================================================
router.get("/check/:appointmentId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });

    if (!appointment) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    res.status(200).json({ 
      success: true, 
      status: appointment.appointmentStatus,
      appointment 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to check status." });
  }
});

// =========================================================================
// GET: Patient appointment history
// =========================================================================
router.get("/my-appointments/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch appointments." });
  }
});

// =========================================================================
// GET: Patient payment history
// =========================================================================
router.get("/my-payments/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .toArray();

    const appointmentIds = appointments.map(a => a._id);
    const payments = await db.collection("Payments")
      .find({ appointmentId: { $in: appointmentIds } })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch payments." });
  }
});

// =========================================================================
// GET: DOCTOR'S PENDING APPOINTMENT REQUESTS
// =========================================================================
router.get("/pending/:doctorEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doctorEmail = req.params.doctorEmail.toLowerCase();

    // Get doctor's ID first
    const doctor = await db.collection("Doctor").findOne({ 
      email: doctorEmail 
    });

    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    // Get all pending appointments for this doctor
    const pendingAppointments = await db.collection("Appointments")
      .find({
        doctorId: doctor._id,
        appointmentStatus: "pending"
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, appointments: pendingAppointments });
  } catch (error) {
    console.error("Failed to fetch pending appointments:", error);
    res.status(500).json({ success: false, message: "Failed to fetch pending appointments." });
  }
});

// =========================================================================
// PATCH: DOCTOR ACCEPTS APPOINTMENT REQUEST
// =========================================================================
router.patch("/request/:appointmentId/accept", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.appointmentId;

    const result = await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "confirmed",
          acceptedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }

    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    res.status(200).json({ success: true, message: "Appointment accepted!", appointment });
  } catch (error) {
    console.error("Accept failed:", error);
    res.status(500).json({ success: false, message: "Failed to accept appointment." });
  }
});


// POST: REQUEST APPOINTMENT (before payment)

router.post("/request", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const {
      doctorId, doctorName,
      patientId, patientEmail, patientName,
      date, timeSlot, problem
    } = req.body;

    if (!doctorId || !patientEmail || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const normalizedEmail = patientEmail.toLowerCase();

   
    const restriction = await db.collection("UserRestrictions").findOne({
      email: normalizedEmail
    });

    if (restriction) {
      const now = new Date();
      const restrictionUntil = new Date(restriction.until);

      if (now <= restrictionUntil) {
        // Still restricted
        if (restriction.status === "banned") {
          return res.status(403).json({ 
            success: false, 
            message: "Your account is banned. You cannot book appointments.",
            status: "banned"
          });
        } else {
          return res.status(403).json({ 
            success: false, 
            message: `You are restricted from booking until ${new Date(restriction.until).toLocaleDateString()}. Reason: ${restriction.reason}`,
            status: "restricted",
            until: restriction.until
          });
        }
      } else {
        // Restriction expired, remove it
        await db.collection("UserRestrictions").deleteOne({ email: normalizedEmail });
      }
    }

    const doctorOid = new ObjectId(doctorId);
    const patientOid = patientId ? new ObjectId(patientId) : null;
    const now = new Date();

    // Save appointment as PENDING (waiting for doctor approval)
    const appointmentDoc = {
      patientId: patientOid,
      patientEmail: normalizedEmail,
      patientName,
      doctorId: doctorOid,
      doctorName,
      appointmentDate: date,
      appointmentTime: timeSlot,
      appointmentStatus: "pending",
      symptoms: problem || "General consultation",
      paymentStatus: "unpaid",
      createdAt: now
    };

    const result = await db.collection("Appointments").insertOne(appointmentDoc);

    res.status(201).json({ 
      success: true, 
      message: "Appointment request sent to doctor!",
      appointmentId: result.insertedId 
    });

  } catch (error) {
    console.error("Request appointment failed:", error);
    res.status(500).json({ success: false, message: "Failed to request appointment." });
  }
});

// =========================================================================
// GET: CHECK APPOINTMENT STATUS (for polling on booking page)
// =========================================================================
router.get("/check/:appointmentId", async (req, res) => {
  try {
    const db          = await connectToDatabase();
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(req.params.appointmentId)
    });
    if (!appointment) return res.status(404).json({ success: false });
    res.status(200).json({
      success:     true,
      status:      appointment.appointmentStatus,
      appointment
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// =========================================================================
// PATCH: DOCTOR REJECTS APPOINTMENT REQUEST
// =========================================================================
router.patch("/request/:appointmentId/reject", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.appointmentId;
    const { reason } = req.body;

    const result = await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "rejected",
          rejectionReason: reason || "Doctor rejected the request",
          rejectedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }

    res.status(200).json({ success: true, message: "Appointment rejected." });
  } catch (error) {
    console.error("Reject failed:", error);
    res.status(500).json({ success: false, message: "Failed to reject appointment." });
  }
});


// =========================================================================
// GET: CHECK USER BOOKING RESTRICTION
// =========================================================================
router.get("/check-restriction/:email", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const userEmail = decodeURIComponent(req.params.email).toLowerCase();

    // Check if user has a restriction
    const restriction = await db.collection("UserRestrictions").findOne({
      email: userEmail
    });

    if (!restriction) {
      return res.status(200).json({ success: true, status: "active" });
    }

    // Check if restriction is still active
    const now = new Date();
    const restrictionUntil = new Date(restriction.until);

    if (now > restrictionUntil) {
      // Restriction expired, remove it
      await db.collection("UserRestrictions").deleteOne({ email: userEmail });
      return res.status(200).json({ success: true, status: "active" });
    }

    // Restriction is still active
    res.status(200).json({
      success: true,
      status: restriction.status || "restricted", // "restricted" or "banned"
      until: restriction.until,
      reason: restriction.reason
    });
  } catch (error) {
    console.error("Restriction check failed:", error);
    res.status(500).json({ success: false, message: "Failed to check restriction." });
  }
});

module.exports = router;