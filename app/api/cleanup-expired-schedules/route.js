import { NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const FOUR_MONTHS_MS = 4 * 30 * 24 * 60 * 60 * 1000;

function adminApp() {
  if (getApps().length) return getApps()[0];
  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

export async function GET(request) {
  const authHeader = request.headers.get("authorization") || "";
  if (authHeader !== "Bearer " + process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getFirestore(adminApp());
  const cutoff = new Date(Date.now() - FOUR_MONTHS_MS).toISOString();

  const snap = await db.collection("schedules").where("updatedAt", "<", cutoff).get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  if (snap.docs.length) await batch.commit();

  return NextResponse.json({ deleted: snap.docs.length, cutoff });
}
