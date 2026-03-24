const { PrismaClient } = require("@prisma/client");

/** @type {PrismaClient} */
let prisma;

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  // Reuse client across hot-reloads in development
  if (!global.__prisma) {
    global.__prisma = new PrismaClient();
  }
  prisma = global.__prisma;
}

module.exports = prisma;
