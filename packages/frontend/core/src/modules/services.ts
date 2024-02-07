import {
  AuthenticationProvider,
  GlobalCache,
  GlobalState,
  type ServiceCollection,
  Workspace,
  WorkspaceScope,
} from '@toeverything/infra';

import { CollectionService } from './collection';
import { AffineCloudAuthenticationProvider } from './infra-web/auth';
import {
  LocalStorageGlobalCache,
  LocalStorageGlobalState,
} from './infra-web/storage';
import { CurrentPageService } from './page';
import {
  CurrentWorkspaceService,
  WorkspacePropertiesAdapter,
} from './workspace';

export function configureBusinessServices(services: ServiceCollection) {
  services.add(CurrentWorkspaceService);
  services
    .scope(WorkspaceScope)
    .add(CurrentPageService)
    .add(WorkspacePropertiesAdapter, [Workspace])
    .add(CollectionService, [Workspace]);
}

export function configureWebInfraServices(services: ServiceCollection) {
  services
    .addImpl(GlobalCache, LocalStorageGlobalCache)
    .addImpl(GlobalState, LocalStorageGlobalState)
    .addImpl(AuthenticationProvider, AffineCloudAuthenticationProvider, [
      GlobalState,
    ]);
}
