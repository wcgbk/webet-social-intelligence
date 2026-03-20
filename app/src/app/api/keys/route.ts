import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { encrypt, decrypt } from "@/lib/encryption";

// In-memory store for demo — replace with Supabase in production
const keyStore = new Map<string, { grokKey?: string; anthropicKey?: string }>();

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { grokApiKey, anthropicApiKey } = await req.json();
  const encrypted: { grokKey?: string; anthropicKey?: string } = {};

  if (grokApiKey) encrypted.grokKey = encrypt(grokApiKey);
  if (anthropicApiKey) encrypted.anthropicKey = encrypt(anthropicApiKey);

  keyStore.set(session.user.id, {
    ...keyStore.get(session.user.id),
    ...encrypted,
  });

  return Response.json({ success: true });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stored = keyStore.get(session.user.id);
  if (!stored) {
    return Response.json({ grokConfigured: false, anthropicConfigured: false });
  }

  return Response.json({
    grokConfigured: !!stored.grokKey,
    anthropicConfigured: !!stored.anthropicKey,
    // Return decrypted keys for client use (in production, use server-side proxy instead)
    grokApiKey: stored.grokKey ? decrypt(stored.grokKey) : undefined,
    anthropicApiKey: stored.anthropicKey ? decrypt(stored.anthropicKey) : undefined,
  });
}
