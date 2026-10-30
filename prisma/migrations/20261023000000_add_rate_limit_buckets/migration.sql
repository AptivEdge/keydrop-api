CREATE TABLE "rate_limit_buckets" (
    "bucket_key" CHAR(64) NOT NULL,
    "timestamps" TIMESTAMP(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("bucket_key")
);

CREATE INDEX "rate_limit_buckets_last_seen_at_idx"
ON "rate_limit_buckets"("last_seen_at");
