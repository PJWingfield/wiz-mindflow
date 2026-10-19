-- Legacy tables (empty): evaluate auth.uid() once per query, not per row. Semantics unchanged.
begin;
alter policy "Users can create own conversations" on public.conversations with check ((select auth.uid()) = user_id);
alter policy "Users can delete own conversations" on public.conversations using ((select auth.uid()) = user_id);
alter policy "Users can update own conversations" on public.conversations using ((select auth.uid()) = user_id);
alter policy "Users can view own conversations" on public.conversations using ((select auth.uid()) = user_id);
alter policy "Users can delete own documents" on public.user_documents using ((select auth.uid()) = user_id);
alter policy "Users can upload own documents" on public.user_documents with check ((select auth.uid()) = user_id);
alter policy "Users can view own documents" on public.user_documents using ((select auth.uid()) = user_id);
alter policy "Users can update own profile" on public.users using ((select auth.uid()) = id);
alter policy "Users can view own profile" on public.users using ((select auth.uid()) = id);
commit;
