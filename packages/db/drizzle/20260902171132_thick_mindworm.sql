ALTER TABLE "job_events" DROP CONSTRAINT "job_events_type_check";--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_type_check" CHECK ("job_events"."event_type" in (
        'done', 'cancelled', 'error',
        'stage_update', 'outline_ready',
        'generating_opinions', 'opinions_ready', 'searching', 'search_done',
        'extracting', 'extract_done',
        'writing_chapter', 'reviewing_chapter', 'chapter_done',
        'reviewing_full', 'review_done'
      ));