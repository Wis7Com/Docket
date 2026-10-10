-- Search reranker preferences. All nullable with no default: NULL means "use
-- the built-in default" (enabled when the model + llama-server are installed,
-- depth 30). Value validation lives in the PATCH /user/profile route so a bad
-- value can never make a migration fail on a project database.
ALTER TABLE user_profiles ADD COLUMN reranker_enabled INTEGER;
ALTER TABLE user_profiles ADD COLUMN reranker_depth INTEGER;
ALTER TABLE user_profiles ADD COLUMN reranker_base_url TEXT;
ALTER TABLE user_profiles ADD COLUMN reranker_model_path TEXT;
