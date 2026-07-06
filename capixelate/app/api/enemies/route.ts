import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const enemies = await prisma.enemy.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ enemies });
  } catch {
    return NextResponse.json({ error: "Failed to fetch enemies" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const enemy = await prisma.enemy.create({
      data: {
        name: body.name,
        type: body.type ?? "ship",
        modelUrl: body.modelUrl,
        lootImageUrl: body.lootImageUrl,
        hitPoints: body.hitPoints ?? 3,
        cannonAccuracy: body.cannonAccuracy ?? 0.5,
        difficulty: body.difficulty ?? "normal",
        behavior: body.behavior ?? "fight",
        attackMode: body.attackMode ?? "cannon",
        fleeThreshold: body.fleeThreshold ?? 0.25,
        lootValue: body.lootValue ?? 100,
        lootDifficulty: body.lootDifficulty ?? "normal",
        zoneX: body.zoneX ?? 0,
        zoneZ: body.zoneZ ?? 0,
        zoneRadius: body.zoneRadius ?? 200,
        speed: body.speed ?? 1,
        spawnCount: body.spawnCount ?? 1,
        isActive: true,
      },
    });
    return NextResponse.json({ enemy });
  } catch {
    return NextResponse.json({ error: "Failed to create enemy" }, { status: 500 });
  }
}
