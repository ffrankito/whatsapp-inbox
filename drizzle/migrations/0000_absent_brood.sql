CREATE TABLE "ghl_installs" (
	"location_id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"creado_en" timestamp DEFAULT now() NOT NULL,
	"actualizado_en" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversaciones_standalone" (
	"id" text PRIMARY KEY NOT NULL,
	"numero" text NOT NULL,
	"contact_id" text NOT NULL,
	"phone" text NOT NULL,
	"full_name" text NOT NULL,
	"estado" text DEFAULT 'sin_asignar' NOT NULL,
	"asignada_a_id" text,
	"asignada_a_nombre" text,
	"creado_en" timestamp DEFAULT now() NOT NULL,
	"actualizado_en" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mensajes_standalone" (
	"id" text PRIMARY KEY NOT NULL,
	"conversacion_id" text NOT NULL,
	"body" text NOT NULL,
	"direction" text NOT NULL,
	"date_added" timestamp DEFAULT now() NOT NULL,
	"adjunto" jsonb,
	"status" text,
	"wa_id" text
);
