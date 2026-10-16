/*
  Warnings:

  - Added the required column `title` to the `ListeningEvent` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ListeningEvent" DROP CONSTRAINT "ListeningEvent_trackId_fkey";

-- DropIndex
DROP INDEX "ListeningEvent_userId_idx";

-- AlterTable
ALTER TABLE "ListeningEvent" ADD COLUMN     "artist" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "composer" TEXT,
ADD COLUMN     "era" TEXT,
ADD COLUMN     "genre" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "mood" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "title" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ReelEvent" ADD COLUMN     "artist" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "SearchIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchIntent_userId_createdAt_idx" ON "SearchIntent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ListeningEvent_userId_createdAt_idx" ON "ListeningEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "SearchIntent" ADD CONSTRAINT "SearchIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
