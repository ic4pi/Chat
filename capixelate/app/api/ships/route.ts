import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const ships = await prisma.ship.findMany({
      where: { isActive: true },
    });
    return NextResponse.json({ ships });
  } catch {
    return NextResponse.json({ error: "Failed to fetch ships" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ship = await prisma.ship.create({
      data: {
        name: body.name,
        type: body.type ?? "player",
        modelUrl: body.modelUrl,
        isActive: true,
      },
    });
    return NextResponse.json({ ship });
  } catch {
    return NextResponse.json({ error: "Failed to create ship" }, { status: 500 });
  }
}
