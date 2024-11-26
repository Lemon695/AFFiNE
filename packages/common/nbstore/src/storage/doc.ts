import EventEmitter2 from 'eventemitter2';
import { diffUpdate, encodeStateVectorFromUpdate, mergeUpdates } from 'yjs';

import type { Lock } from './lock';
import { SingletonLocker } from './lock';
import { Storage, type StorageOptions } from './storage';

export interface DocClock {
  docId: string;
  timestamp: Date;
}

export type DocClocks = Record<string, Date>;
export interface DocRecord extends DocClock {
  bin: Uint8Array;
  editor?: string;
}

export interface DocDiff extends DocClock {
  missing: Uint8Array;
  state: Uint8Array;
}

export interface DocUpdate {
  docId: string;
  bin: Uint8Array;
  editor?: string;
}

export interface Editor {
  name: string;
  avatarUrl: string | null;
}

export interface DocStorageOptions extends StorageOptions {
  mergeUpdates?: (updates: Uint8Array[]) => Promise<Uint8Array> | Uint8Array;
}

export abstract class DocStorage<
  Opts extends DocStorageOptions = DocStorageOptions,
> extends Storage<Opts> {
  private readonly event = new EventEmitter2();
  override readonly storageType = 'doc';
  private readonly locker = new SingletonLocker();

  /**
   * Tell a binary is empty yjs binary or not.
   *
   * NOTE:
   *   `[0, 0]` is empty yjs update binary
   *   `[0]` is empty yjs state vector binary
   */
  isEmptyBin(bin: Uint8Array): boolean {
    return (
      bin.length === 0 ||
      // 0x0 for state vector
      (bin.length === 1 && bin[0] === 0) ||
      // 0x00 for update
      (bin.length === 2 && bin[0] === 0 && bin[1] === 0)
    );
  }

  // REGION: open apis by Op system
  /**
   * Get a doc record with latest binary.
   */
  async getDoc(docId: string) {
    await using _lock = await this.lockDocForUpdate(docId);

    const snapshot = await this.getDocSnapshot(docId);
    const updates = await this.getDocUpdates(docId);

    if (updates.length) {
      const { timestamp, bin, editor } = await this.squash(
        snapshot ? [snapshot, ...updates] : updates
      );

      const newSnapshot = {
        spaceId: this.spaceId,
        docId,
        bin,
        timestamp,
        editor,
      };

      await this.setDocSnapshot(newSnapshot, snapshot);

      // always mark updates as merged unless throws
      await this.markUpdatesMerged(docId, updates);

      return newSnapshot;
    }

    return snapshot;
  }

  /**
   * Get a yjs binary diff with the given state vector.
   */
  async getDocDiff(docId: string, state?: Uint8Array) {
    const doc = await this.getDoc(docId);

    if (!doc) {
      return null;
    }

    return {
      docId,
      missing: state ? diffUpdate(doc.bin, state) : doc.bin,
      state: encodeStateVectorFromUpdate(doc.bin),
      timestamp: doc.timestamp,
    };
  }

  /**
   * Push updates into storage
   */
  abstract pushDocUpdate(update: DocUpdate): Promise<DocClock>;

  /**
   * Get all docs timestamps info. especially for useful in sync process.
   */
  abstract getDocTimestamps(after?: Date): Promise<DocClocks>;

  /**
   * Delete a specific doc data with all snapshots and updates
   */
  abstract deleteDoc(docId: string): Promise<void>;

  /**
   * Subscribe on doc updates emitted from storage itself.
   *
   * NOTE:
   *
   *   There is not always update emitted from storage itself.
   *
   *   For example, in Sqlite storage, the update will only come from user's updating on docs,
   *   in other words, the update will never somehow auto generated in storage internally.
   *
   *   But for Cloud storage, there will be updates broadcasted from other clients,
   *   so the storage will emit updates to notify the client to integrate them.
   */
  subscribeDocUpdate(callback: (update: DocRecord) => void) {
    this.event.on('update', callback);

    return () => {
      this.event.off('update', callback);
    };
  }
  // ENDREGION

  // REGION: api for internal usage
  protected on(
    event: 'update',
    callback: (update: DocRecord) => void
  ): () => void;
  protected on(
    event: 'snapshot',
    callback: (snapshot: DocRecord, prevSnapshot: DocRecord | null) => void
  ): () => void;
  protected on(event: string, callback: (...args: any[]) => void): () => void {
    this.event.on(event, callback);
    return () => {
      this.event.off(event, callback);
    };
  }

  protected emit(event: 'update', update: DocRecord): void;
  protected emit(
    event: 'snapshot',
    snapshot: DocRecord,
    prevSnapshot: DocRecord | null
  ): void;
  protected emit(event: string, ...args: any[]): void {
    this.event.emit(event, ...args);
  }

  protected off(event: string, callback: (...args: any[]) => void): void {
    this.event.off(event, callback);
  }

  /**
   * Get a doc snapshot from storage
   */
  protected abstract getDocSnapshot(docId: string): Promise<DocRecord | null>;
  /**
   * Set the doc snapshot into storage
   *
   * @safety
   * be careful when implementing this method.
   *
   * It might be called with outdated snapshot when running in multi-thread environment.
   *
   * A common solution is update the snapshot record is DB only when the coming one's timestamp is newer.
   *
   * @example
   * ```ts
   * await using _lock = await this.lockDocForUpdate(docId);
   * // set snapshot
   *
   * ```
   */
  protected abstract setDocSnapshot(
    snapshot: DocRecord,
    prevSnapshot: DocRecord | null
  ): Promise<boolean>;

  /**
   * Get all updates of a doc that haven't been merged into snapshot.
   *
   * Updates queue design exists for a performace concern:
   * A huge amount of write time will be saved if we don't merge updates into snapshot immediately.
   * Updates will be merged into snapshot when the latest doc is requested.
   */
  protected abstract getDocUpdates(docId: string): Promise<DocRecord[]>;

  /**
   * Mark updates as merged into snapshot.
   */
  protected abstract markUpdatesMerged(
    docId: string,
    updates: DocRecord[]
  ): Promise<number>;

  /**
   * Merge doc updates into a single update.
   */
  protected async squash(updates: DocRecord[]): Promise<DocRecord> {
    const lastUpdate = updates.at(-1);
    if (!lastUpdate) {
      throw new Error('No updates to be squashed.');
    }

    // fast return
    if (updates.length === 1) {
      return lastUpdate;
    }

    const finalUpdate = await this.mergeUpdates(updates.map(u => u.bin));

    return {
      docId: lastUpdate.docId,
      bin: finalUpdate,
      timestamp: lastUpdate.timestamp,
      editor: lastUpdate.editor,
    };
  }

  protected mergeUpdates(updates: Uint8Array[]) {
    const merge = this.options?.mergeUpdates ?? mergeUpdates;

    return merge(updates.filter(bin => !this.isEmptyBin(bin)));
  }

  protected async lockDocForUpdate(docId: string): Promise<Lock> {
    return this.locker.lock(`workspace:${this.spaceId}:update`, docId);
  }
}