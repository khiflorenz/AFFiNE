-- AlterTable
ALTER TABLE "snapshot_histories" ADD COLUMN     "created_by" TEXT;

-- AddForeignKey
ALTER TABLE "snapshot_histories" ADD CONSTRAINT "snapshot_histories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
