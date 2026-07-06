import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      where: { isActive: true },
      include: { island: true },
      orderBy: { order: "asc" },
    });
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ error: "Failed to fetch projects" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const project = await prisma.project.create({
      data: {
        title: body.title,
        description: body.description,
        url: body.url,
        imageUrl: body.imageUrl,
        iconUrl: body.iconUrl,
        tags: JSON.stringify(body.tags ?? []),
        order: body.order ?? 0,
        islandId: body.islandId,
        isActive: true,
      },
    });
    return NextResponse.json({ project });
  } catch {
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
