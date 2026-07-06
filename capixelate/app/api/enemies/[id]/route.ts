import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const enemy = await prisma.enemy.update({
      where: { id },
      data: {
        name: body.name,
        type: body.type,
        modelUrl: body.modelUrl,
        lootImageUrl: body.lootImageUrl,
        hitPoints: body.hitPoints,
        cannonAccuracy: body.cannonAccuracy,
        difficulty: body.difficulty,
        behavior: body.behavior,
        attackMode: body.attackMode,
        fleeThreshold: body.fleeThreshold,
        lootValue: body.lootValue,
        lootDifficulty: body.lootDifficulty,
        zoneX: body.zoneX,
        zoneZ: body.zoneZ,
        zoneRadius: body.zoneRadius,
        speed: body.speed,
        spawnCount: body.spawnCount,
        isActive: body.isActive,
      },
    });
    return NextResponse.json({ enemy });
  } catch {
    return NextResponse.json({ error: "Failed to update enemy" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.enemy.update({
      where: { id },
      data: { isActive: false },
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete enemy" }, { status: 500 });
  }
}
