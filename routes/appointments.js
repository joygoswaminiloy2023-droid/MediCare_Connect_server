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
    const db = await connectToDatabase();
    const oid = new ObjectId(req.params.id);
    const doctor = await db.collection("Doctor").findOne({ _id: oid });
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found." });
    res.status(200).json({ success: true, doctor });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch doctor." });
  }
});

// =========================================================================
// POST: REQUEST APPOINTMENT (before payment) - Creates ONE appointment
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

    const normalizedEmail = patientEmail.toLowerCase();
    
    // CHECK RESTRICTION FROM USER COLLECTION
    const user = await db.collection("user").findOne({ 
      email: normalizedEmail 
    });

    if (user) {
      if (user.status === "banned") {
        return res.status(403).json({ 
          success: false, 
          message: "Your account is banned. You cannot book appointments.",
          status: "banned"
        });
      }

      if (user.status === "restricted" && user.restrictedUntil) {
        const now = new Date();
        const restrictionUntil = new Date(user.restrictedUntil);

        if (now <= restrictionUntil) {
          return res.status(403).json({ 
            success: false, 
            message: `You are restricted from booking until ${restrictionUntil.toLocaleDateString()}.`,
            status: "restricted",
            until: user.restrictedUntil
          });
        } else {
          await db.collection("user").updateOne(
            { email: normalizedEmail },
            { 
              $set: { status: "active" }, 
              $unset: { restrictedUntil: "", restrictedAt: "" } 
            }
          );
        }
      }
    }

    // ✅ CHECK FOR EXISTING PENDING APPOINTMENT (PREVENT DUPLICATES)
    const existingAppointment = await db.collection("Appointments").findOne({
      doctorId: new ObjectId(doctorId),
      patientEmail: normalizedEmail,
      appointmentDate: date,
      appointmentTime: timeSlot,
      appointmentStatus: { $in: ["pending", "confirmed"] }
    });

    if (existingAppointment) {
      return res.status(409).json({ 
        success: false, 
        message: "You already have a pending appointment with this doctor at this time.",
        appointmentId: existingAppointment._id
      });
    }

    const doctorOid = new ObjectId(doctorId);
    const patientOid = patientId ? new ObjectId(patientId) : null;
    const now = new Date();

    // ✅ CREATE ONE APPOINTMENT - PENDING
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
      createdAt: now,
      updatedAt: now
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
// POST: Create Stripe checkout session - USES EXISTING APPOINTMENT
// =========================================================================
router.post("/create-checkout", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const {
      appointmentId, // ✅ REQUIRED - Use existing appointment
      doctorId, 
      doctorName,
      patientId, 
      patientEmail, 
      patientName,
      date, 
      timeSlot, 
      problem, 
      consultationFee
    } = req.body;

    // ✅ MUST have appointmentId
    if (!appointmentId) {
      return res.status(400).json({ 
        success: false, 
        message: "Appointment ID is required. Please request an appointment first." 
      });
    }

    if (!doctorId || !patientEmail || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // ✅ FIND EXISTING APPOINTMENT
    const appointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!appointment) {
      return res.status(404).json({ 
        success: false, 
        message: "Appointment not found." 
      });
    }

    // ✅ Check if already paid
    if (appointment.paymentStatus === "paid") {
      return res.status(400).json({ 
        success: false, 
        message: "Appointment already paid." 
      });
    }

    // ✅ Check if appointment is confirmed by doctor
    if (appointment.appointmentStatus !== "confirmed") {
      return res.status(400).json({ 
        success: false, 
        message: "Appointment must be confirmed by the doctor before payment." 
      });
    }

    const fee = Number(consultationFee) || 0;
    const doctorOid = new ObjectId(doctorId);
    const patientOid = patientId ? new ObjectId(patientId) : null;

    // ✅ UPDATE EXISTING APPOINTMENT - DO NOT CREATE NEW
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      { 
        $set: { 
          paymentStatus: "pending",
          paymentInitiatedAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );

    // Check if payment record exists
    const existingPayment = await db.collection("Payments").findOne({
      appointmentId: new ObjectId(appointmentId)
    });

    if (!existingPayment) {
      // Create payment record only if it doesn't exist
      await db.collection("Payments").insertOne({
        appointmentId: new ObjectId(appointmentId),
        patientId: patientOid,
        doctorId: doctorOid,
        amount: fee,
        transactionId: null,
        paymentDate: null,
        paymentStatus: "pending",
        createdAt: new Date()
      });
    }

    // ✅ Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: patientEmail,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Consultation with ${doctorName}`,
            description: `${date} at ${timeSlot} — ${problem || "General consultation"}`,
          },
          unit_amount: Math.round(fee * 100),
        },
        quantity: 1,
      }],
      metadata: { 
        appointmentId, 
        doctorId, 
        patientEmail 
      },
      success_url: `${CLIENT_URL}/appointments/success?appointmentId=${appointmentId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/appointments/book/${doctorId}?cancelled=true`,
    });

    res.status(200).json({ 
      success: true, 
      url: session.url, 
      appointmentId 
    });

  } catch (error) {
    console.error("Checkout creation failed:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create checkout.", 
      error: error.message 
    });
  }
});

// =========================================================================
// POST: Confirm appointment after Stripe redirects back
// =========================================================================
router.post("/confirm/:appointmentId", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { sessionId } = req.body;
    const appointmentId = req.params.appointmentId;

    // Verify payment status directly with Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(402).json({ success: false, message: "Payment not completed." });
    }

    const now = new Date();

    // ✅ UPDATE EXISTING APPOINTMENT - DO NOT CREATE NEW
    await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "confirmed",
          paymentStatus: "paid",
          stripeSessionId: session.id,
          confirmedAt: now,
          amount: session.amount_total / 100,
          updatedAt: now
        }
      }
    );

    // Update Payments with transaction details
    await db.collection("Payments").updateOne(
      { appointmentId: new ObjectId(appointmentId) },
      {
        $set: {
          transactionId: session.payment_intent,
          paymentDate: now,
          paymentStatus: "paid",
          amount: session.amount_total / 100,
          stripeSessionId: session.id
        }
      },
      { upsert: true }
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
// GET: Patient appointment history (NO DUPLICATES)
// =========================================================================
router.get("/my-appointments/:patientEmail", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointments = await db.collection("Appointments")
      .find({ patientEmail: req.params.patientEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();
    
    // ✅ Remove duplicates based on unique combination
    const uniqueAppointments = [];
    const seen = new Set();
    
    for (const apt of appointments) {
      const key = `${apt.doctorId}-${apt.appointmentDate}-${apt.appointmentTime}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueAppointments.push(apt);
      }
    }
    
    res.status(200).json({ success: true, appointments: uniqueAppointments });
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

    const doctor = await db.collection("Doctor").findOne({ 
      email: doctorEmail 
    });

    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

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
// PATCH: DOCTOR ACCEPTS APPOINTMENT REQUEST - UPDATES ONLY
// =========================================================================
router.patch("/request/:appointmentId/accept", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.appointmentId;

    // ✅ Check if appointment exists
    const existingAppointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!existingAppointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }

    // ✅ Only accept if pending
    if (existingAppointment.appointmentStatus !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot accept appointment with status: ${existingAppointment.appointmentStatus}` 
      });
    }

    // ✅ UPDATE ONLY - DO NOT CREATE NEW
    const result = await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "confirmed",
          acceptedAt: new Date(),
          updatedAt: new Date()
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

// =========================================================================
// PATCH: DOCTOR REJECTS APPOINTMENT REQUEST - UPDATES ONLY
// =========================================================================
router.patch("/request/:appointmentId/reject", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const appointmentId = req.params.appointmentId;
    const { reason } = req.body;

    const existingAppointment = await db.collection("Appointments").findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!existingAppointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }

    if (existingAppointment.appointmentStatus !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot reject appointment with status: ${existingAppointment.appointmentStatus}` 
      });
    }

    const result = await db.collection("Appointments").updateOne(
      { _id: new ObjectId(appointmentId) },
      {
        $set: {
          appointmentStatus: "rejected",
          rejectionReason: reason || "Doctor rejected the request",
          rejectedAt: new Date(),
          updatedAt: new Date()
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

    const user = await db.collection("user").findOne({
      email: userEmail
    });

    if (!user) {
      return res.status(200).json({ success: true, status: "active" });
    }

    if (user.status === "banned") {
      return res.status(200).json({
        success: true,
        status: "banned",
        reason: "Your account has been permanently banned."
      });
    }

    if (user.status === "restricted" && user.restrictedUntil) {
      const now = new Date();
      const restrictionUntil = new Date(user.restrictedUntil);

      if (now > restrictionUntil) {
        await db.collection("user").updateOne(
          { email: userEmail },
          { 
            $set: { status: "active" }, 
            $unset: { restrictedUntil: "", restrictedAt: "" } 
          }
        );
        return res.status(200).json({ success: true, status: "active" });
      }

      return res.status(200).json({
        success: true,
        status: "restricted",
        until: user.restrictedUntil,
        reason: "Temporary restriction placed by admin."
      });
    }

    res.status(200).json({ success: true, status: "active" });
  } catch (error) {
    console.error("Restriction check failed:", error);
    res.status(500).json({ success: false, message: "Failed to check restriction." });
  }
});

// =========================================================================
// POST: Stripe Webhook - Updates payment status
// =========================================================================
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const appointmentId = session.metadata?.appointmentId;

    if (appointmentId) {
      try {
        const db = await connectToDatabase();
        // ✅ UPDATE EXISTING APPOINTMENT - DO NOT CREATE NEW
        await db.collection("Appointments").updateOne(
          { _id: new ObjectId(appointmentId) },
          { 
            $set: { 
              paymentStatus: "paid",
              paymentId: session.payment_intent,
              paidAt: new Date(),
              updatedAt: new Date()
            } 
          }
        );
        
        await db.collection("Payments").updateOne(
          { appointmentId: new ObjectId(appointmentId) },
          {
            $set: {
              transactionId: session.payment_intent,
              paymentDate: new Date(),
              paymentStatus: "paid",
              amount: session.amount_total / 100,
              stripeSessionId: session.id
            }
          },
          { upsert: true }
        );
        
        console.log(`✅ Payment confirmed for appointment ${appointmentId}`);
      } catch (error) {
        console.error("Webhook update failed:", error);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;