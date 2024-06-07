import { map } from 'rxjs';

import { Entity } from '../../../framework';
import { LiveData } from '../../../livedata';
import type { DocsStore } from '../stores/docs';
import { type DocMode,DocRecord } from './record';

export class DocRecordList extends Entity {
  constructor(private readonly store: DocsStore) {
    super();
  }

  private readonly pool = new Map<string, DocRecord>();

  public readonly docs$ = LiveData.from<DocRecord[]>(
    this.store.watchDocIds().pipe(
      map(ids =>
        ids.map(id => {
          const exists = this.pool.get(id);
          if (exists) {
            return exists;
          }
          const record = this.framework.createEntity(DocRecord, { id });
          this.pool.set(id, record);
          return record;
        })
      )
    ),
    []
  );

  public readonly isReady$ = LiveData.from(
    this.store.watchDocListReady(),
    false
  );

  public doc$(id: string) {
    return this.docs$.map(record => record.find(record => record.id === id));
  }

  public setDocMode(id: string, mode: DocMode) {
    return this.store.setDocModeSetting(id, mode);
  }
}
