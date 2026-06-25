const { MongoClient } = require("mongodb");
require("dotenv").config();


const uri = process.env.MONGO_DB_URI || process.env.MONGODB_URI;

if (!uri) {
  console.error("CRITICAL ERROR: MONGO_DB_URI is undefined in your environment variables.");
  console.error("Available env vars:", Object.keys(process.env).filter(key => key.includes('MONGO')));
 
}

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {

  if (cachedDb) {
    console.log("Using cached database connection");
    return cachedDb;
  }

  if (!uri) {
    throw new Error("MongoDB URI is not defined. Please set MONGO_DB_URI or MONGODB_URI in environment variables.");
  }

  try {

    if (!cachedClient) {
      cachedClient = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        connectTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 30000,
      });
      
      console.log("Creating new MongoDB client...");
    }


    if (!cachedClient.topology || !cachedClient.topology.isConnected()) {
      console.log("Connecting to MongoDB...");
      await cachedClient.connect();
      console.log("MongoDB connected successfully");
    }

  
    cachedDb = cachedClient.db("Medicare_connect");
    
    
    await cachedDb.command({ ping: 1 });
    console.log("Database 'Medicare_connect' is ready");
    
    return cachedDb;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);

    cachedClient = null;
    cachedDb = null;
    throw error;
  }
}


async function closeDatabase() {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedDb = null;
    console.log("Database connection closed");
  }
}

module.exports = { connectToDatabase, closeDatabase };