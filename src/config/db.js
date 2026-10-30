import mongoose from 'mongoose';

export async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`[DB] Connesso a MongoDB: ${conn.connection.host}`);
  } catch (error) {
    console.error(`[DB] Errore connessione MongoDB: ${error.message}`);
    process.exit(1);
  }
}
