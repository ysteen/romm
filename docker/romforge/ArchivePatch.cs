using SharpCompress.Archives;

internal static class ArchivePatch
{
    public static readonly string[] Extensions = [".zip", ".7z", ".rar"];
    public static readonly string[] PatchExtensions = [".ips", ".bps", ".ups", ".aps", ".ppf", ".xdelta", ".vcdiff"];

    public static string Extract(string path, string directory, bool layered, bool rom = false)
    {
        long limit = long.Parse(Environment.GetEnvironmentVariable(rom ? "ROMFORGE_MAX_3DS_SIZE" : "ROMFORGE_MAX_EXPANDED_SIZE") ?? (rom ? "8589934592" : "2147483648"));
        long written = 0;
        int count = 0;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var files = new List<string>();
        Directory.CreateDirectory(directory);
        using var archive = ArchiveFactory.OpenArchive(path);
        foreach (var entry in archive.Entries)
        {
            if (++count > 20000) throw new InvalidDataException("Archive contains too many entries");
            string key = (entry.Key ?? "").Replace('\\', '/').TrimEnd('/');
            if (key.Length == 0 || key.StartsWith('/') || key.Contains(':') || key.Split('/').Any(p => p is ".." or "." or "") || !names.Add(key))
                throw new InvalidDataException("Unsafe or duplicate archive path");
            if (entry.IsEncrypted || !string.IsNullOrEmpty(entry.LinkTarget))
                throw new InvalidDataException("Encrypted archives and links are unsupported");
            if (entry.IsDirectory) continue;
            if (entry.Size < 0 || entry.Size > limit - written) throw new InvalidDataException("Expanded patch exceeds limit");
            string target = Path.Combine(directory, key);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var source = entry.OpenEntryStream();
            using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write);
            byte[] buffer = new byte[65536];
            int read;
            while ((read = source.Read(buffer)) != 0)
            {
                written += read;
                if (written > limit) throw new InvalidDataException("Expanded patch exceeds limit");
                output.Write(buffer, 0, read);
            }
            files.Add(target);
        }
        if (rom)
        {
            var games = files.Where(f => new[]{".3ds", ".cci", ".cia"}.Contains(Path.GetExtension(f).ToLowerInvariant())).ToArray();
            if (games.Length != 1) throw new InvalidDataException("ROM archive must contain exactly one 3DS/CCI/CIA file");
            if (files.Any(f => f != games[0] && !new[]{".txt", ".nfo", ".md", ".jpg", ".jpeg", ".png", ".url"}.Contains(Path.GetExtension(f).ToLowerInvariant())))
                throw new InvalidDataException("ROM archive contains additional payloads; extract the intended game first");
            return games[0];
        }
        if (layered)
        {
            var roots = files.Select(f => Path.GetRelativePath(directory, f).Replace('\\', '/'))
                .Select(f => f.Split('/')).Select(parts => {
                    int index = Array.FindIndex(parts, p => p is "romfs" or "exefs" || p is "code.ips" or "code.bin" or "exheader.bin");
                    return index < 0 ? null : string.Join('/', parts.Take(index));
                }).Where(x => x != null).Distinct().ToArray();
            if (roots.Length != 1) throw new InvalidDataException("Archive must contain exactly one 3DS patch root (romfs, exefs or code.ips)");
            return Path.Combine(directory, roots[0]!);
        }
        var patches = files.Where(f => PatchExtensions.Contains(Path.GetExtension(f).ToLowerInvariant())).ToArray();
        if (patches.Length != 1) throw new InvalidDataException("Archive must contain exactly one binary patch; extract the intended patch first");
        return patches[0];
    }
}
