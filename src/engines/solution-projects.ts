import fs from "node:fs";
import path from "node:path";
import { projectRelativePosix } from "../utils/paths.js";
import { decodeEntities, xmlAttribute } from "./lint/xml-entities.js";

export interface SolutionProject {
	name: string;
	relativePath: string;
	basename: string;
	isCsharp: boolean;
}

const attribute = (tag: string, name: string): string | null => {
	const value = xmlAttribute(tag, name);
	return value !== null ? decodeEntities(value) : null;
};

const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, "");

// Solution folder type GUID used in .sln files to declare virtual groupings.
const SOLUTION_FOLDER_GUID = "2150e333-8fdc-42a3-9474-1a3956d46de8";

const describeProject = (
	rootDirectory: string,
	solutionDirectory: string,
	rawPath: string,
	rawName: string | null,
): SolutionProject => {
	const absoluteProject = path.resolve(solutionDirectory, rawPath.replace(/\\/g, "/"));
	const relativePath = projectRelativePosix(rootDirectory, absoluteProject);
	const extension = path.posix.extname(relativePath);
	const basename = path.posix.basename(relativePath, extension);
	return {
		name: rawName ?? basename,
		relativePath,
		basename,
		isCsharp: relativePath.toLowerCase().endsWith(".csproj"),
	};
};

const parseSlnxProjects = (
	content: string,
	rootDirectory: string,
	solutionDirectory: string,
): SolutionProject[] => {
	const projects: SolutionProject[] = [];
	const projectTagPattern = /<Project\b([^>]*)\/?>/g;
	const cleanContent = stripXmlComments(content);
	let match = projectTagPattern.exec(cleanContent);
	while (match !== null) {
		const tag = match[1];
		const rawPath = attribute(tag, "Path");
		if (rawPath) {
			const rawName = attribute(tag, "DisplayName") ?? attribute(tag, "Name");
			projects.push(describeProject(rootDirectory, solutionDirectory, rawPath, rawName));
		}
		match = projectTagPattern.exec(cleanContent);
	}
	return projects;
};

const parseSlnProjects = (
	content: string,
	rootDirectory: string,
	solutionDirectory: string,
): SolutionProject[] => {
	const projects: SolutionProject[] = [];
	const slnLinePattern =
		/^[ \t]*Project\s*\(\s*"\{?([0-9a-fA-F-]+)\}?"\s*\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"/;
	for (const line of content.split(/\r?\n/)) {
		if (line.trimStart().startsWith("#")) continue;
		const match = slnLinePattern.exec(line);
		if (!match || match[1].toLowerCase() === SOLUTION_FOLDER_GUID) continue;
		projects.push(describeProject(rootDirectory, solutionDirectory, match[3], match[2]));
	}
	return projects;
};

const UTF16_LE_DECODER = new TextDecoder("utf-16le");
const UTF16_BE_DECODER = new TextDecoder("utf-16be");
const XML_ENCODING_PATTERN = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*\?>/i;

const decodeUtf32 = (raw: Buffer, littleEndian: boolean): string | null => {
	if (raw.length % 4 !== 0) return null;
	const codePoints: number[] = [];
	for (let offset = 0; offset < raw.length; offset += 4) {
		const codePoint = littleEndian ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset);
		codePoints.push(codePoint);
	}
	let result = "";
	for (let index = 0; index < codePoints.length; index += 4096) {
		result += String.fromCodePoint(...codePoints.slice(index, index + 4096));
	}
	return result;
};

const detectBomlessUnicode = (
	raw: Buffer,
): "utf-32le" | "utf-32be" | "utf-16le" | "utf-16be" | null => {
	const limit = Math.min(raw.length, 64);
	for (let offset = 0; offset < limit; offset++) {
		const byte = raw[offset];
		if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
		if (
			offset + 3 < raw.length &&
			byte === 0x3c &&
			raw[offset + 1] === 0x00 &&
			raw[offset + 2] === 0x00 &&
			raw[offset + 3] === 0x00
		) {
			return "utf-32le";
		}
		if (
			offset + 3 < raw.length &&
			byte === 0x00 &&
			raw[offset + 1] === 0x00 &&
			raw[offset + 2] === 0x00 &&
			raw[offset + 3] === 0x3c
		) {
			return "utf-32be";
		}
		if (offset + 1 < raw.length && byte === 0x3c && raw[offset + 1] === 0x00) {
			return "utf-16le";
		}
		if (offset + 1 < raw.length && byte === 0x00 && raw[offset + 1] === 0x3c) {
			return "utf-16be";
		}
		if (byte !== 0x00) break;
	}
	return null;
};

const decodeDeclaredXmlEncoding = (raw: Buffer): string | null => {
	const asciiPrefix = raw.subarray(0, Math.min(raw.length, 512)).toString("latin1");
	const match = XML_ENCODING_PATTERN.exec(asciiPrefix);
	const declared = (match?.[1] ?? match?.[2])?.trim().toLowerCase();
	if (!declared || declared === "utf-8" || declared === "utf8") {
		return raw.toString("utf-8");
	}
	try {
		return new TextDecoder(declared).decode(raw);
	} catch {
		return null;
	}
};

const decodeSolutionContent = (raw: Buffer, isSlnx: boolean): string | null => {
	if (raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xfe && raw[2] === 0x00 && raw[3] === 0x00) {
		return decodeUtf32(raw.subarray(4), true);
	}
	if (raw.length >= 4 && raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0xfe && raw[3] === 0xff) {
		return decodeUtf32(raw.subarray(4), false);
	}
	if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
		return raw.subarray(3).toString("utf-8");
	}
	if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
		return raw.length % 2 === 0 ? UTF16_LE_DECODER.decode(raw.subarray(2)) : null;
	}
	if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
		return raw.length % 2 === 0 ? UTF16_BE_DECODER.decode(raw.subarray(2)) : null;
	}
	const bomless = detectBomlessUnicode(raw);
	if (bomless === "utf-32le") return decodeUtf32(raw, true);
	if (bomless === "utf-32be") return decodeUtf32(raw, false);
	if (bomless === "utf-16le") {
		return raw.length % 2 === 0 ? UTF16_LE_DECODER.decode(raw) : null;
	}
	if (bomless === "utf-16be") {
		return raw.length % 2 === 0 ? UTF16_BE_DECODER.decode(raw) : null;
	}
	if (isSlnx) {
		return decodeDeclaredXmlEncoding(raw);
	}
	return raw.toString("utf-8");
};

/**
 * Try to parse the projects a .sln or .slnx declares, returning null when the
 * solution file cannot be read or uses an unsupported/invalid encoding.
 */
export const tryParseSolutionProjects = (
	solutionPath: string,
	rootDirectory: string,
): SolutionProject[] | null => {
	let content: string | null;
	const isSlnx = solutionPath.toLowerCase().endsWith(".slnx");
	try {
		content = decodeSolutionContent(fs.readFileSync(solutionPath), isSlnx);
	} catch {
		return null;
	}
	if (content === null) return null;
	const solutionDirectory = path.dirname(solutionPath);
	return isSlnx
		? parseSlnxProjects(content, rootDirectory, solutionDirectory)
		: parseSlnProjects(content, rootDirectory, solutionDirectory);
};

/** The projects a .sln or .slnx declares, with repository-relative POSIX paths. */
export const parseSolutionProjects = (
	solutionPath: string,
	rootDirectory: string,
): SolutionProject[] => tryParseSolutionProjects(solutionPath, rootDirectory) ?? [];
