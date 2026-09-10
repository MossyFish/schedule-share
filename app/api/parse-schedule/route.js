import { NextResponse } from "next/server";
import { verifyIdToken } from "@/lib/firebaseAdmin";

const DAY_CODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const PROMPT =
  "This image is a screenshot of a weekly class schedule or timetable. " +
  "Identify every distinct class session. Reply with ONLY a JSON array (no markdown, no other text) of objects shaped like " +
  '{"day":"MO"|"TU"|"WE"|"TH"|"FR"|"SA"|"SU","start":"HH:MM" (24-hour),"end":"HH:MM" (24-hour),"title":"short course name","location":"room or building, empty string if unknown"}. ' +
  "If a class meets on multiple days, include one object per day it meets. Estimate end time as 50 minutes after start if unclear.";

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  try {
    await verifyIdToken(token);
  } catch (e) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Gemini API key not configured on the server." }, { status: 500 });
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return NextResponse.json({ error: "Expected multipart form data with an image." }, { status: 400 });
  }
  const file = form.get("image");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No image provided." }, { status: 400 });
  }

  const mimeType = file.type || "image/jpeg";
  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: "Couldn't reach Gemini." }, { status: 502 });
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Gemini request failed (" + geminiRes.status + "): " + errText.slice(0, 300) },
      { status: 502 }
    );
  }

  const data = await geminiRes.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        /* fall through */
      }
    }
  }
  if (!Array.isArray(parsed)) {
    return NextResponse.json({ error: "Couldn't read a schedule from that image." }, { status: 422 });
  }

  const events = parsed
    .map((e) => {
      const day = DAY_CODE[String(e.day || "").toUpperCase()];
      if (day === undefined) return null;
      const start = /^\d{2}:\d{2}$/.test(e.start) ? e.start : "09:00";
      const end = /^\d{2}:\d{2}$/.test(e.end) ? e.end : start;
      return {
        day,
        start,
        end,
        title: String(e.title || "Class").slice(0, 80),
        location: String(e.location || "").slice(0, 80),
      };
    })
    .filter(Boolean);

  if (!events.length) {
    return NextResponse.json({ error: "Couldn't find any classes in that image." }, { status: 422 });
  }

  return NextResponse.json({ events });
}
