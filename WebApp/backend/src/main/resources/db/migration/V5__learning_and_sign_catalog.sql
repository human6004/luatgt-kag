-- Keep legacy content, exams and study_attempts intact for existing clients/history.
CREATE TABLE bank_release (
 release_id BINARY(16) PRIMARY KEY, release_code VARCHAR(40) NOT NULL UNIQUE,
 title VARCHAR(500) NOT NULL, issued_on DATE, effective_from DATE, effective_to DATE, source_url VARCHAR(2000),
 CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE TABLE question_set (
 set_id BINARY(16) PRIMARY KEY, release_id BINARY(16) NOT NULL, set_code VARCHAR(30) NOT NULL, set_name VARCHAR(500) NOT NULL,
 UNIQUE(release_id,set_code), UNIQUE(set_id,release_id), FOREIGN KEY(release_id) REFERENCES bank_release(release_id)
);
CREATE TABLE topic (
 topic_id BINARY(16) PRIMARY KEY, release_id BINARY(16) NOT NULL, topic_code VARCHAR(30) NOT NULL, topic_name VARCHAR(500) NOT NULL,
 chapter SMALLINT NOT NULL CHECK(chapter BETWEEN 1 AND 6),
 UNIQUE(release_id,topic_code), UNIQUE(release_id,chapter), UNIQUE(topic_id,release_id),
 FOREIGN KEY(release_id) REFERENCES bank_release(release_id)
);
CREATE TABLE question (
 question_id BINARY(16) PRIMARY KEY, FOREIGN KEY(question_id) REFERENCES content(id)
);
CREATE TABLE question_revision (
 revision_id BINARY(16) PRIMARY KEY, question_id BINARY(16) NOT NULL, revision_no BIGINT NOT NULL,
 question_text LONGTEXT NOT NULL, explanation LONGTEXT, choice_mode VARCHAR(10) NOT NULL CHECK(choice_mode='single'),
 external_id VARCHAR(250) NOT NULL, source_text VARCHAR(2000) NOT NULL,
 UNIQUE(question_id,revision_no), FOREIGN KEY(question_id) REFERENCES question(question_id)
);
CREATE TABLE answer_option (
 option_id BINARY(16) PRIMARY KEY, revision_id BINARY(16) NOT NULL, option_position SMALLINT NOT NULL,
 option_text LONGTEXT NOT NULL, is_correct BOOLEAN NOT NULL, image_url VARCHAR(2000),
 UNIQUE(revision_id,option_position), UNIQUE(option_id,revision_id),
 FOREIGN KEY(revision_id) REFERENCES question_revision(revision_id), CHECK(option_position BETWEEN 0 AND 3)
);
CREATE TABLE question_asset (
 asset_id BINARY(16) PRIMARY KEY, revision_id BINARY(16) NOT NULL, display_order SMALLINT NOT NULL,
 media_url VARCHAR(1000) NOT NULL, mime_type VARCHAR(100) NOT NULL, alt_text VARCHAR(1000),
 UNIQUE(revision_id,display_order), FOREIGN KEY(revision_id) REFERENCES question_revision(revision_id)
);
CREATE TABLE set_question (
 set_question_id BINARY(16) PRIMARY KEY, set_id BINARY(16) NOT NULL, revision_id BINARY(16) NOT NULL,
 topic_id BINARY(16) NOT NULL, release_id BINARY(16) NOT NULL, source_no INTEGER NOT NULL CHECK(source_no>0), is_critical BOOLEAN NOT NULL,
 UNIQUE(set_id,source_no), UNIQUE(set_id,revision_id), UNIQUE(set_question_id,set_id), UNIQUE(set_question_id,revision_id),
 FOREIGN KEY(set_id,release_id) REFERENCES question_set(set_id,release_id),
 FOREIGN KEY(topic_id,release_id) REFERENCES topic(topic_id,release_id),
 FOREIGN KEY(revision_id) REFERENCES question_revision(revision_id)
);
CREATE TABLE license_class (
 class_id BINARY(16) PRIMARY KEY, class_code VARCHAR(12) NOT NULL UNIQUE, class_name VARCHAR(200) NOT NULL
);
CREATE TABLE exam_rule (
 rule_id BINARY(16) PRIMARY KEY, set_id BINARY(16) NOT NULL, class_id BINARY(16) NOT NULL,
 valid_from DATE NOT NULL, valid_to DATE, total_questions SMALLINT NOT NULL, duration_minutes SMALLINT NOT NULL,
 minimum_correct SMALLINT NOT NULL, critical_slots SMALLINT NOT NULL, fail_on_critical BOOLEAN NOT NULL,
 UNIQUE(set_id,class_id,valid_from), UNIQUE(rule_id,set_id),
 FOREIGN KEY(set_id) REFERENCES question_set(set_id), FOREIGN KEY(class_id) REFERENCES license_class(class_id),
 CHECK(valid_to IS NULL OR valid_to>valid_from), CHECK(total_questions>0 AND duration_minutes>0),
 CHECK(minimum_correct BETWEEN 1 AND total_questions), CHECK(critical_slots BETWEEN 0 AND total_questions)
);
CREATE TABLE exam_rule_topic (
 rule_id BINARY(16) NOT NULL, topic_id BINARY(16) NOT NULL, question_quota SMALLINT NOT NULL CHECK(question_quota>=0),
 PRIMARY KEY(rule_id,topic_id), FOREIGN KEY(rule_id) REFERENCES exam_rule(rule_id), FOREIGN KEY(topic_id) REFERENCES topic(topic_id)
);
CREATE TABLE exam_attempt (
 attempt_id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL, rule_id BINARY(16) NOT NULL, set_id BINARY(16) NOT NULL,
 started_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL, submitted_at DATETIME(6),
 score INTEGER, critical_failed BOOLEAN, passed BOOLEAN,
 UNIQUE(attempt_id,set_id), FOREIGN KEY(user_id) REFERENCES accounts(id), FOREIGN KEY(rule_id,set_id) REFERENCES exam_rule(rule_id,set_id)
);
CREATE INDEX exam_attempt_owner ON exam_attempt(user_id,started_at);
CREATE TABLE attempt_question (
 attempt_question_id BINARY(16) PRIMARY KEY, attempt_id BINARY(16) NOT NULL, set_question_id BINARY(16) NOT NULL,
 set_id BINARY(16) NOT NULL, revision_id BINARY(16) NOT NULL, display_position SMALLINT NOT NULL,
 UNIQUE(attempt_id,display_position), UNIQUE(attempt_id,set_question_id), UNIQUE(attempt_question_id,revision_id),
 FOREIGN KEY(attempt_id,set_id) REFERENCES exam_attempt(attempt_id,set_id),
 FOREIGN KEY(set_question_id,set_id) REFERENCES set_question(set_question_id,set_id),
 FOREIGN KEY(set_question_id,revision_id) REFERENCES set_question(set_question_id,revision_id)
);
CREATE TABLE attempt_answer (
 attempt_question_id BINARY(16) PRIMARY KEY, option_id BINARY(16) NOT NULL, revision_id BINARY(16) NOT NULL,
 FOREIGN KEY(attempt_question_id,revision_id) REFERENCES attempt_question(attempt_question_id,revision_id),
 FOREIGN KEY(option_id,revision_id) REFERENCES answer_option(option_id,revision_id)
);
CREATE TABLE study_attempt (
 study_attempt_id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL, set_question_id BINARY(16) NOT NULL,
 selected_option_id BINARY(16) NOT NULL, revision_id BINARY(16) NOT NULL, correct BOOLEAN NOT NULL, created_at DATETIME(6) NOT NULL,
 FOREIGN KEY(user_id) REFERENCES accounts(id),
 FOREIGN KEY(set_question_id,revision_id) REFERENCES set_question(set_question_id,revision_id),
 FOREIGN KEY(selected_option_id,revision_id) REFERENCES answer_option(option_id,revision_id)
);
CREATE INDEX study_attempt_owner ON study_attempt(user_id,created_at);
CREATE TABLE nhom_enum (nhom_id VARCHAR(200) PRIMARY KEY, nhom_name VARCHAR(200) NOT NULL UNIQUE);
CREATE TABLE qcvn_enum (qcvn_id VARCHAR(200) PRIMARY KEY, qcvn_name VARCHAR(200) NOT NULL UNIQUE);
CREATE TABLE record_type_enum (record_type_id VARCHAR(30) PRIMARY KEY, record_type_name VARCHAR(100) NOT NULL UNIQUE);
INSERT INTO record_type_enum VALUES ('family','family'),('variant','variant'),('standalone','standalone'),('unverified_code','unverified_code');
CREATE TABLE images (
 image_id BINARY(16) PRIMARY KEY, image_url VARCHAR(768) NOT NULL UNIQUE, file_name VARCHAR(500), metadata LONGTEXT
);
CREATE TABLE signs (
 sign_id VARCHAR(250) PRIMARY KEY, content_id BINARY(16) NOT NULL UNIQUE, ma_bien VARCHAR(100) NOT NULL,
 nhom VARCHAR(200) NOT NULL, ten VARCHAR(500) NOT NULL, mo_ta LONGTEXT,
 qcvn VARCHAR(200), record_type VARCHAR(30), parent_code VARCHAR(100), children_codes LONGTEXT,
 description_scope VARCHAR(100), unit_id VARCHAR(500), image_required BOOLEAN, image_id BINARY(16),
 image_status VARCHAR(100), verification_status VARCHAR(100), note LONGTEXT,
 FOREIGN KEY(content_id) REFERENCES content(id), FOREIGN KEY(nhom) REFERENCES nhom_enum(nhom_id),
 FOREIGN KEY(qcvn) REFERENCES qcvn_enum(qcvn_id), FOREIGN KEY(record_type) REFERENCES record_type_enum(record_type_id),
 FOREIGN KEY(image_id) REFERENCES images(image_id)
);
CREATE INDEX signs_version_code ON signs(qcvn,ma_bien);
