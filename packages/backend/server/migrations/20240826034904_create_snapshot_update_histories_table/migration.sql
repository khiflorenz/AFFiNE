-- CreateTable
CREATE TABLE "snapshot_update_histories" (
    "id" VARCHAR NOT NULL,
    "created_by" VARCHAR,
    "guid" VARCHAR NOT NULL,
    "last_updated_by" VARCHAR,
    "workspace_id" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshot_update_histories_pk" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "snapshot_update_histories" ADD CONSTRAINT "created_by_user_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_update_histories" ADD CONSTRAINT "last_updated_by_user_fk" FOREIGN KEY ("last_updated_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_update_histories_snapshot_id_uk" ON "snapshot_update_histories"("guid", "workspace_id");
