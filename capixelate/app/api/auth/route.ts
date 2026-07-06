import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? "capixelate-secret-key"
);

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    // Check env credentials first (quick admin)
    const envUser = process.env.ADMIN_USERNAME ?? "admin";
    const envPass = process.env.ADMIN_PASSWORD ?? "capixelate2024";

    let valid = false;
    if (username === envUser && password === envPass) {
      valid = true;
    } else {
      // Check DB users
      const user = await prisma.adminUser.findUnique({ where: { username } });
      if (user) {
        valid = await bcrypt.compare(password, user.passwordHash);
      }
    }

    if (!valid) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const token = await new SignJWT({ username, role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("24h")
      .setIssuedAt()
      .sign(SECRET);

    const response = NextResponse.json({ success: true, token });
    response.cookies.set("capixelate_admin", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Auth failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get("capixelate_admin")?.value;
    if (!token) return NextResponse.json({ authenticated: false });

    await jwtVerify(token, SECRET);
    return NextResponse.json({ authenticated: true });
  } catch {
    return NextResponse.json({ authenticated: false });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete("capixelate_admin");
  return response;
}
