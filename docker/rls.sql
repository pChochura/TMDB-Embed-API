-- -------------------------------------------------------------
-- Row Level Security (RLS) Policies for Supabase
-- -------------------------------------------------------------

-- 1. Helper function to extract user ID from Supabase Auth or JWT claims
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    auth.uid()::text,
    auth.jwt() ->> 'id',
    auth.jwt() ->> 'sub'
  );
$$;

-- 2. Enable RLS on all public tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watch_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- 3. Favorites policies
DROP POLICY IF EXISTS "Users can view their own favorites" ON public.favorites;
CREATE POLICY "Users can view their own favorites"
  ON public.favorites FOR SELECT
  TO authenticated
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can insert their own favorites" ON public.favorites;
CREATE POLICY "Users can insert their own favorites"
  ON public.favorites FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can update their own favorites" ON public.favorites;
CREATE POLICY "Users can update their own favorites"
  ON public.favorites FOR UPDATE
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can delete their own favorites" ON public.favorites;
CREATE POLICY "Users can delete their own favorites"
  ON public.favorites FOR DELETE
  TO authenticated
  USING (user_id = public.current_user_id());

-- 4. Watchlist policies
DROP POLICY IF EXISTS "Users can view their own watchlist" ON public.watchlist;
CREATE POLICY "Users can view their own watchlist"
  ON public.watchlist FOR SELECT
  TO authenticated
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can insert their own watchlist items" ON public.watchlist;
CREATE POLICY "Users can insert their own watchlist items"
  ON public.watchlist FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can update their own watchlist items" ON public.watchlist;
CREATE POLICY "Users can update their own watchlist items"
  ON public.watchlist FOR UPDATE
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can delete their own watchlist items" ON public.watchlist;
CREATE POLICY "Users can delete their own watchlist items"
  ON public.watchlist FOR DELETE
  TO authenticated
  USING (user_id = public.current_user_id());

-- 5. Watch progress policies
DROP POLICY IF EXISTS "Users can view their own watch progress" ON public.watch_progress;
CREATE POLICY "Users can view their own watch progress"
  ON public.watch_progress FOR SELECT
  TO authenticated
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can insert their own watch progress" ON public.watch_progress;
CREATE POLICY "Users can insert their own watch progress"
  ON public.watch_progress FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can update their own watch progress" ON public.watch_progress;
CREATE POLICY "Users can update their own watch progress"
  ON public.watch_progress FOR UPDATE
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can delete their own watch progress" ON public.watch_progress;
CREATE POLICY "Users can delete their own watch progress"
  ON public.watch_progress FOR DELETE
  TO authenticated
  USING (user_id = public.current_user_id());

-- 6. User preferences policies
DROP POLICY IF EXISTS "Users can view their own preferences" ON public.user_preferences;
CREATE POLICY "Users can view their own preferences"
  ON public.user_preferences FOR SELECT
  TO authenticated
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can insert their own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert their own preferences"
  ON public.user_preferences FOR INSERT
  TO authenticated
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can update their own preferences" ON public.user_preferences;
CREATE POLICY "Users can update their own preferences"
  ON public.user_preferences FOR UPDATE
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

DROP POLICY IF EXISTS "Users can delete their own preferences" ON public.user_preferences;
CREATE POLICY "Users can delete their own preferences"
  ON public.user_preferences FOR DELETE
  TO authenticated
  USING (user_id = public.current_user_id());

-- 7. Users table policies
DROP POLICY IF EXISTS "Users can view their own user profile" ON public.users;
CREATE POLICY "Users can view their own user profile"
  ON public.users FOR SELECT
  TO authenticated
  USING (id = public.current_user_id());

DROP POLICY IF EXISTS "Users can update their own user profile" ON public.users;
CREATE POLICY "Users can update their own user profile"
  ON public.users FOR UPDATE
  TO authenticated
  USING (id = public.current_user_id())
  WITH CHECK (id = public.current_user_id());

-- 8. Grants for PostgREST
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
