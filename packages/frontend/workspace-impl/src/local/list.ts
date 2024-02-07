import { apis } from '@affine/electron-api';
import { WorkspaceFlavour } from '@affine/env/workspace';
import { Workspace as BlockSuiteWorkspace } from '@blocksuite/store';
import type { WorkspaceListProvider } from '@toeverything/infra';
import {
  type BlobStorage,
  LiveData,
  type WorkspaceInfo,
  type WorkspaceMetadata,
} from '@toeverything/infra';
import { globalBlockSuiteSchema } from '@toeverything/infra';
import type { CleanupService } from '@toeverything/infra/lifecycle';
import { nanoid } from 'nanoid';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';

import { IndexedDBBlobStorage } from './blob-indexeddb';
import { SQLiteBlobStorage } from './blob-sqlite';
import {
  LOCAL_WORKSPACE_CREATED_BROADCAST_CHANNEL_KEY,
  LOCAL_WORKSPACE_LOCAL_STORAGE_KEY,
} from './consts';
import { IndexedDBSyncStorage } from './sync-indexeddb';
import { SQLiteSyncStorage } from './sync-sqlite';

export class LocalWorkspaceListProvider implements WorkspaceListProvider {
  name = WorkspaceFlavour.LOCAL;

  notifyChannel = new BroadcastChannel(
    LOCAL_WORKSPACE_CREATED_BROADCAST_CHANNEL_KEY
  );

  list = new LiveData(this.getList());

  constructor(cleanUp: CleanupService) {
    this.notifyChannel.addEventListener('message', () => {
      this.revalidate();
    });

    cleanUp.add(() => {
      this.notifyChannel.close();
    });
  }

  private getList(): WorkspaceMetadata[] {
    return JSON.parse(
      localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY) ?? '[]'
    ).map((id: string) => ({ id, flavour: WorkspaceFlavour.LOCAL }));
  }

  private revalidate() {
    this.list.next(this.getList());
  }

  async delete(workspaceId: string) {
    const allWorkspaceIDs: string[] = JSON.parse(
      localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY) ?? '[]'
    );
    localStorage.setItem(
      LOCAL_WORKSPACE_LOCAL_STORAGE_KEY,
      JSON.stringify(allWorkspaceIDs.filter(x => x !== workspaceId))
    );

    if (apis && environment.isDesktop) {
      await apis.workspace.delete(workspaceId);
    }

    // notify all browser tabs, so they can update their workspace list
    this.notifyChannel.postMessage(workspaceId);
    this.revalidate();
  }

  async create(
    initial: (
      workspace: BlockSuiteWorkspace,
      blobStorage: BlobStorage
    ) => Promise<void>
  ): Promise<WorkspaceMetadata> {
    const id = nanoid();

    const blobStorage = environment.isDesktop
      ? new SQLiteBlobStorage(id)
      : new IndexedDBBlobStorage(id);
    const syncStorage = environment.isDesktop
      ? new SQLiteSyncStorage(id)
      : new IndexedDBSyncStorage(id);

    const workspace = new BlockSuiteWorkspace({
      id: id,
      idGenerator: () => nanoid(),
      schema: globalBlockSuiteSchema,
    });

    // apply initial state
    await initial(workspace, blobStorage);

    // save workspace to local storage
    await syncStorage.push(id, encodeStateAsUpdate(workspace.doc));
    for (const subdocs of workspace.doc.getSubdocs()) {
      await syncStorage.push(subdocs.guid, encodeStateAsUpdate(subdocs));
    }

    // save workspace id to local storage
    const allWorkspaceIDs: string[] = JSON.parse(
      localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY) ?? '[]'
    );
    allWorkspaceIDs.push(id);
    localStorage.setItem(
      LOCAL_WORKSPACE_LOCAL_STORAGE_KEY,
      JSON.stringify(allWorkspaceIDs)
    );

    // notify all browser tabs, so they can update their workspace list
    this.notifyChannel.postMessage(id);
    this.revalidate();

    return { id, flavour: WorkspaceFlavour.LOCAL };
  }

  async getInformation(id: string): Promise<WorkspaceInfo | undefined> {
    // get information from root doc
    const storage = environment.isDesktop
      ? new SQLiteSyncStorage(id)
      : new IndexedDBSyncStorage(id);
    const data = await storage.pull(id, new Uint8Array([]));

    if (!data) {
      return;
    }

    const bs = new BlockSuiteWorkspace({
      id,
      schema: globalBlockSuiteSchema,
    });

    applyUpdate(bs.doc, data.data);

    return {
      name: bs.meta.name,
      avatar: bs.meta.avatar,
    };
  }
}
