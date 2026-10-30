ALTER TABLE "User" RENAME COLUMN "cognitoSubject" TO "identitySubject";

ALTER INDEX "User_cognitoSubject_key" RENAME TO "User_identitySubject_key";
