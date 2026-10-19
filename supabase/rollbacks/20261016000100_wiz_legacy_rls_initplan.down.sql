-- Restores the original per-row auth.uid() expressions.
begin;
alter policy "Users can create own conversations" on public.conversations with check (auth.uid() = user_id);
alter policy "Users can delete own conversations" on public.conversations using (auth.uid() = user_id);
alter policy "Users can update own conversations" on public.conversations using (auth.uid() = user_id);
alter policy "Users can view own conversations" on public.conversations using (auth.uid() = user_id);
alter policy "Users can delete own documents" on public.user_documents using (auth.uid() = user_id);
alter policy "Users can upload own documents" on public.user_documents with check (auth.uid() = user_id);
alter policy "Users can view own documents" on public.user_documents using (auth.uid() = user_id);
alter policy "Users can update own profile" on public.users using (auth.uid() = id);
alter policy "Users can view own profile" on public.users using (auth.uid() = id);
commit;
