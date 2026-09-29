"""Bound native patch output without changing limits on the API or worker."""

import os
import resource
import sys


def main() -> None:
    limit = int(sys.argv[1])
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    main()
