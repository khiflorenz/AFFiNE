-- AlterTable
ALTER TABLE "snapshots"
ADD COLUMN  "created_by" VARCHAR,
ADD COLUMN  "last_updated_by" VARCHAR;
