-- AlterTable
ALTER TABLE "User" ADD COLUMN "cognitoSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_cognitoSubject_key" ON "User"("cognitoSubject");
