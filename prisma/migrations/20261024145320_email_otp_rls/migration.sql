ALTER TABLE "EmailOtp" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "EmailOtp" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "EmailOtp" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE "EmailOtp" FROM authenticated';
  END IF;
END
$$;
