-- CreateTable
CREATE TABLE "ReelEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "feedId" TEXT,
    "eventType" TEXT NOT NULL,
    "mood" TEXT,
    "dwellMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReelEvent_userId_eventType_createdAt_idx" ON "ReelEvent"("userId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ReelEvent_userId_trackId_idx" ON "ReelEvent"("userId", "trackId");

-- CreateIndex
CREATE INDEX "ReelEvent_createdAt_idx" ON "ReelEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "ReelEvent" ADD CONSTRAINT "ReelEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
