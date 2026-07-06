import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const project = await prisma.project.update({
      where: { id },
      data: {
        title: body.title,
        description: body.description,
        url: body.url,
        imageUrl: body.imageUrl,
        iconUrl: body.iconUrl,
        tags: JSON.stringify(body.tags ?? []),
        order: body.order,
        islandId: body.islandId,
        isActive: body.isActive,
      },
    });
    return NextResponse.json({ project });
  } catch {
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.project.update({
      where: { id },
      data: { isActive: false },
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete project" }, { status: 500 });
  }
}
