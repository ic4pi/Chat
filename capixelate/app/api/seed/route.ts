import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST() {
  try {
    // Clear existing
    await prisma.project.deleteMany();
    await prisma.island.deleteMany();
    await prisma.enemy.deleteMany();

    // Create islands
    const island1 = await prisma.island.create({
      data: {
        name: "Showcase Isle",
        posX: 0,
        posZ: -220,
        scale: 1.3,
        isActive: true,
      },
    });

    const island2 = await prisma.island.create({
      data: {
        name: "Discovery Cove",
        posX: 350,
        posZ: -280,
        scale: 0.95,
        isActive: true,
      },
    });

    const island3 = await prisma.island.create({
      data: {
        name: "Horizon Reach",
        posX: -300,
        posZ: -340,
        scale: 1.0,
        isActive: true,
      },
    });

    // Create projects
    await prisma.project.create({
      data: {
        title: "Project Alpha",
        description:
          "A cutting-edge web application built with modern technologies. Features real-time collaboration and advanced data visualization.",
        url: "https://example.com/project-alpha",
        tags: JSON.stringify(["React", "Node.js", "WebSocket", "D3.js"]),
        order: 0,
        islandId: island1.id,
        isActive: true,
      },
    });

    await prisma.project.create({
      data: {
        title: "Project Beta",
        description:
          "An AI-powered creative tool that transforms how artists and designers work. Leverages machine learning for real-time style transfer.",
        url: "https://example.com/project-beta",
        tags: JSON.stringify(["Next.js", "Python", "TensorFlow", "Three.js"]),
        order: 1,
        islandId: island2.id,
        isActive: true,
      },
    });

    await prisma.project.create({
      data: {
        title: "Project Gamma",
        description:
          "A decentralized marketplace with immersive 3D product showcases. Built on modern web standards with WebGL and WASM.",
        url: "https://example.com/project-gamma",
        tags: JSON.stringify(["TypeScript", "WebGL", "WASM", "GraphQL"]),
        order: 2,
        islandId: island3.id,
        isActive: true,
      },
    });

    // Create enemies
    await prisma.enemy.create({
      data: {
        name: "Corsair Sloop",
        type: "ship",
        hitPoints: 3,
        cannonAccuracy: 0.45,
        difficulty: "easy",
        behavior: "fight",
        attackMode: "cannon",
        fleeThreshold: 0.1,
        lootValue: 75,
        lootDifficulty: "easy",
        zoneX: 150,
        zoneZ: -100,
        zoneRadius: 180,
        speed: 0.9,
        spawnCount: 2,
        isActive: true,
      },
    });

    await prisma.enemy.create({
      data: {
        name: "Dread Galleon",
        type: "ship",
        hitPoints: 6,
        cannonAccuracy: 0.65,
        difficulty: "hard",
        behavior: "fight",
        attackMode: "cannon",
        fleeThreshold: 0.15,
        lootValue: 300,
        lootDifficulty: "hard",
        zoneX: -200,
        zoneZ: -180,
        zoneRadius: 220,
        speed: 0.7,
        spawnCount: 1,
        isActive: true,
      },
    });

    await prisma.enemy.create({
      data: {
        name: "Kraken",
        type: "monster",
        hitPoints: 10,
        cannonAccuracy: 0.8,
        difficulty: "legendary",
        behavior: "fight",
        attackMode: "tentacle",
        fleeThreshold: 0.05,
        lootValue: 1000,
        lootDifficulty: "legendary",
        zoneX: 200,
        zoneZ: -400,
        zoneRadius: 300,
        speed: 0.5,
        spawnCount: 1,
        isActive: true,
      },
    });

    await prisma.enemy.create({
      data: {
        name: "Sea Serpent",
        type: "monster",
        hitPoints: 7,
        cannonAccuracy: 0.6,
        difficulty: "hard",
        behavior: "fleeBeforeSink",
        attackMode: "bite",
        fleeThreshold: 0.3,
        lootValue: 500,
        lootDifficulty: "hard",
        zoneX: -350,
        zoneZ: -250,
        zoneRadius: 250,
        speed: 1.2,
        spawnCount: 1,
        isActive: true,
      },
    });

    return NextResponse.json({ success: true, message: "Database seeded successfully" });
  } catch (err) {
    console.error("Seed error:", err);
    return NextResponse.json({ error: "Seed failed" }, { status: 500 });
  }
}
