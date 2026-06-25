# 🏥 MediCare Connect Server

Backend API service for MediCare Connect Healthcare Management Platform.

## 🌐 Live API

(Add your Render/Railway/VPS API URL here)

---

## 🔗 Repositories

Client:
https://github.com/joygoswaminiloy2023-droid/MediCare_Connect

Server:
https://github.com/joygoswaminiloy2023-droid/MediCare_Connect_server

---

## 🚀 Backend Features

### Authentication

* JWT Authentication
* Firebase Token Verification
* Role-Based Authorization
* Protected API Routes

### Users

* User Registration
* Profile Management
* Role Management
* User Suspension

### Doctors

* Doctor Registration
* Verification Workflow
* Schedule Management
* Profile Updates

### Appointments

* Appointment Booking
* Appointment Rescheduling
* Appointment Cancellation
* Status Tracking

### Reviews

* Create Review
* Update Review
* Delete Review

### Prescriptions

* Create Prescription
* Update Prescription
* Patient Prescription History

### Payments

* Stripe Payment Intent
* Transaction Storage
* Payment History

### Analytics

* Total Doctors
* Total Patients
* Total Appointments
* Doctor Performance Metrics

---

## 🛠️ Technologies Used

### Backend

* Node.js
* Express.js
* MongoDB Atlas
* JWT
* Stripe
* Firebase Admin SDK
* CORS
* Dotenv

---

## 🔒 JWT Authentication Flow

1. User logs in.
2. Firebase verifies user.
3. JWT token is generated.
4. Token is sent to client.
5. Client stores token securely.
6. Protected routes verify token.
7. Role-based middleware validates access permissions.

---

## 🗄️ Database Collections

### Users

* name
* email
* role
* photo
* phone
* gender
* createdAt
* status

### Doctors

* doctorName
* specialization
* qualifications
* experience
* consultationFee
* hospitalName
* profileImage
* availableDays
* availableSlots
* verificationStatus

### Appointments

* patientId
* doctorId
* appointmentDate
* appointmentTime
* appointmentStatus
* symptoms
* paymentStatus

### Reviews

* patientId
* doctorId
* rating
* reviewText
* createdAt

### Payments

* appointmentId
* patientId
* doctorId
* amount
* transactionId
* paymentDate

### Prescriptions

* doctorId
* patientId
* appointmentId
* diagnosis
* medications
* notes
* createdAt

---

## ⚙️ Installation

```bash
git clone https://github.com/joygoswaminiloy2023-droid/MediCare_Connect_server.git

cd MediCare_Connect_server

npm install

npm run dev
```

---

## 🔑 Environment Variables

Create a `.env` file:

```env
PORT=5000

DB_USER=
DB_PASS=

JWT_SECRET=

STRIPE_SECRET_KEY=

FIREBASE_PROJECT_ID=
FIREBASE_PRIVATE_KEY=
FIREBASE_CLIENT_EMAIL=
```

---

## 🛡️ Security Features

* JWT Verification
* Role-Based Authorization
* Protected Routes
* Environment Variable Protection
* MongoDB Security Practices
* Secure Stripe Integration

---

## 👨‍💻 Developed By

Joy Goswami Niloy
