// Generated from the design (ADR 2026-067); do not edit: the design gate regenerates it.
// The one place that decides which adapter backs which port.
import {
  DrizzleAddMemberStore,
  DrizzleAddTagStore,
  DrizzleCreateAccountStore,
  DrizzleCreateTaggingSchemeStore,
  DrizzleCreateWorkspaceStore,
  DrizzleDeleteAccountStore,
  DrizzleDeleteMemberStore,
  DrizzleDeleteTagStore,
  DrizzleDeleteTaggingSchemeStore,
  DrizzleGetAccountStore,
  DrizzleGetWorkspaceStore,
  DrizzleListAccountsStore,
  DrizzleListMembersStore,
  DrizzleListProvidersStore,
  DrizzleListRevaluationsStore,
  DrizzleListTaggingSchemesStore,
  DrizzleListTagsStore,
  DrizzleListWorkspacesStore,
  DrizzleMoveTagStore,
  DrizzleMoveTaggingSchemeStore,
  DrizzleRenameMemberStore,
  DrizzleRenameTagStore,
  DrizzleRenameTaggingSchemeStore,
  DrizzleRenameWorkspaceStore,
  DrizzleRevalueAccountStore,
  DrizzleUpdateAccountStore,
  DrizzleUpdateWorkspaceCurrenciesStore,
} from "@dogfood/net-worth/adapters/drizzle";
import { createNetWorthRouter, type NetWorthRouter } from "@dogfood/net-worth/adapters/trpc";
import {
  AddMemberHandler,
  AddTagHandler,
  CreateAccountHandler,
  CreateTaggingSchemeHandler,
  CreateWorkspaceHandler,
  DeleteAccountHandler,
  DeleteMemberHandler,
  DeleteTagHandler,
  DeleteTaggingSchemeHandler,
  GetAccountHandler,
  GetWorkspaceHandler,
  ListAccountsHandler,
  ListMembersHandler,
  ListProvidersHandler,
  ListRevaluationsHandler,
  ListTaggingSchemesHandler,
  ListTagsHandler,
  ListWorkspacesHandler,
  MoveTagHandler,
  MoveTaggingSchemeHandler,
  RenameMemberHandler,
  RenameTagHandler,
  RenameTaggingSchemeHandler,
  RenameWorkspaceHandler,
  RevalueAccountHandler,
  UpdateAccountHandler,
  UpdateWorkspaceCurrenciesHandler,
} from "@dogfood/net-worth/application";
import { drizzle } from "drizzle-orm/node-postgres";

export function composeApp(): NetWorthRouter {
  const db = drizzle(connectionUrl());

  return createNetWorthRouter({
    accounts: {
      create: new CreateAccountHandler(new DrizzleCreateAccountStore(db)),
      delete: new DeleteAccountHandler(new DrizzleDeleteAccountStore(db)),
      get: new GetAccountHandler(new DrizzleGetAccountStore(db)),
      list: new ListAccountsHandler(new DrizzleListAccountsStore(db)),
      listProviders: new ListProvidersHandler(new DrizzleListProvidersStore(db)),
      listRevaluations: new ListRevaluationsHandler(new DrizzleListRevaluationsStore(db)),
      revalue: new RevalueAccountHandler(new DrizzleRevalueAccountStore(db)),
      update: new UpdateAccountHandler(new DrizzleUpdateAccountStore(db)),
    },
    members: {
      add: new AddMemberHandler(new DrizzleAddMemberStore(db)),
      delete: new DeleteMemberHandler(new DrizzleDeleteMemberStore(db)),
      list: new ListMembersHandler(new DrizzleListMembersStore(db)),
      rename: new RenameMemberHandler(new DrizzleRenameMemberStore(db)),
    },
    taggingSchemes: {
      addTag: new AddTagHandler(new DrizzleAddTagStore(db)),
      create: new CreateTaggingSchemeHandler(new DrizzleCreateTaggingSchemeStore(db)),
      deleteTag: new DeleteTagHandler(new DrizzleDeleteTagStore(db)),
      delete: new DeleteTaggingSchemeHandler(new DrizzleDeleteTaggingSchemeStore(db)),
      list: new ListTaggingSchemesHandler(new DrizzleListTaggingSchemesStore(db)),
      listTags: new ListTagsHandler(new DrizzleListTagsStore(db)),
      moveTag: new MoveTagHandler(new DrizzleMoveTagStore(db)),
      move: new MoveTaggingSchemeHandler(new DrizzleMoveTaggingSchemeStore(db)),
      renameTag: new RenameTagHandler(new DrizzleRenameTagStore(db)),
      rename: new RenameTaggingSchemeHandler(new DrizzleRenameTaggingSchemeStore(db)),
    },
    workspaces: {
      create: new CreateWorkspaceHandler(new DrizzleCreateWorkspaceStore(db)),
      get: new GetWorkspaceHandler(new DrizzleGetWorkspaceStore(db)),
      list: new ListWorkspacesHandler(new DrizzleListWorkspacesStore(db)),
      rename: new RenameWorkspaceHandler(new DrizzleRenameWorkspaceStore(db)),
      updateCurrencies: new UpdateWorkspaceCurrenciesHandler(new DrizzleUpdateWorkspaceCurrenciesStore(db)),
    },
  });
}

// DATABASE_URL comes only from the environment: never a hard-coded address, never a fallback.
function connectionUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value === "") throw new Error("DATABASE_URL is not set");
  return value;
}
