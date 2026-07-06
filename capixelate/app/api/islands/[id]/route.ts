import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const island = await prisma.island.update({
      where: { id },
      data: {
        name: body.name,
        posX: body.posX,
        posZ: body.posZ,
        scale: body.scale,
        modelUrl: body.modelUrl,
        isActive: body.isActive,
      },
    });
    return NextResponse.json({ island });
  } catch {
    return NextResponse.json({ error: "Failed to update island" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.island.update({
      where: { id },
      data: { isActive: false },
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete island" }, { status: 500 });
  }
}
